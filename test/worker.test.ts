import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Account } from "../src/durable/Account";

const BASE = "https://felt.test";

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (event) => resolve(JSON.parse(event.data as string)),
      { once: true },
    );
  });
}

let lastToken = "";
async function newRoom(): Promise<string> {
  const account = await exports.default.fetch(`${BASE}/v1/accounts`, {
    method: "POST",
    body: JSON.stringify({ name: "Ana" }),
  });
  const { token } = ((await account.json()) as { data: { token: string } })
    .data;
  lastToken = token;
  const room = await exports.default.fetch(`${BASE}/v1/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ game: "blackjack" }),
  });
  return ((await room.json()) as { data: { code: string } }).data.code;
}

async function connect(code?: string, origin = "http://localhost:3000") {
  code ??= await newRoom();
  const response = await exports.default.fetch(`${BASE}/v1/rooms/${code}/ws`, {
    headers: { Upgrade: "websocket", Origin: origin },
  });
  return response;
}

describe("HTTP", () => {
  it("answers the health check with the API envelope", async () => {
    const response = await exports.default.fetch(`${BASE}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { ok: true },
      error: null,
      message: "",
    });
  });

  it("returns NOT_FOUND for unknown routes", async () => {
    const response = await exports.default.fetch(`${BASE}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});

describe("room WebSocket", () => {
  it("rejects an invalid room code", async () => {
    const response = await connect("AB0O1");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  it("requires a WebSocket upgrade", async () => {
    const code = await newRoom();
    const response = await exports.default.fetch(`${BASE}/v1/rooms/${code}/ws`);
    expect(response.status).toBe(426);
  });

  it("refuses an origin that is not allowed", async () => {
    const response = await connect(undefined, "https://evil.example");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "FORBIDDEN_ORIGIN" },
    });
  });

  it("answers ping with pong", async () => {
    const response = await connect();
    expect(response.status).toBe(101);
    const ws = response.webSocket as WebSocket;
    ws.accept();
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: "ping" }));
    expect(await reply).toEqual({ t: "pong" });
    ws.close();
  });

  it("echoes a valid message back through the room", async () => {
    const ws = (await connect()).webSocket as WebSocket;
    ws.accept();
    ws.send(JSON.stringify({ t: "hello", v: 1, token: lastToken }));
    await nextMessage(ws);
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: "emote", id: "gg" }));
    expect(await reply).toEqual({
      t: "echo",
      message: { t: "emote", id: "gg" },
    });
    ws.close();
  });

  it.each([
    "not json",
    JSON.stringify({ t: "fly" }),
    "x".repeat(5000),
  ])("rejects a bad message", async (raw) => {
    const ws = (await connect()).webSocket as WebSocket;
    ws.accept();
    const reply = nextMessage(ws);
    ws.send(raw);
    expect(await reply).toEqual({ t: "error", code: "BAD_REQUEST" });
    ws.close();
  });
});

describe("Account Durable Object", () => {
  it("creates its SQLite schema on start", async () => {
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("hash-of-a-token"));
    await runInDurableObject(stub, async (instance: Account, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .toArray()
        .map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining(["account", "history", "ledger"]),
      );
      expect(instance.exists()).toBe(false);
    });
  });
});
