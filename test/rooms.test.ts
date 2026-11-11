import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://felt.test";

async function token() {
  const res = await exports.default.fetch(`${BASE}/v1/accounts`, {
    method: "POST",
    body: JSON.stringify({ name: "Ana" }),
  });
  return ((await res.json()) as { data: { token: string } }).data.token;
}

const create = async (body: unknown, auth?: string) =>
  exports.default.fetch(`${BASE}/v1/rooms`, {
    method: "POST",
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    body: JSON.stringify(body),
  });

describe("POST /v1/rooms", () => {
  it("requires an account", async () => {
    expect((await create({ game: "blackjack" })).status).toBe(401);
  });

  it("creates rooms with distinct valid codes", async () => {
    const t = await token();
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const res = await create({ game: "blackjack" }, t);
      expect(res.status).toBe(201);
      const { code } = ((await res.json()) as { data: { code: string } }).data;
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(20);
  });

  it("rejects bad config", async () => {
    const t = await token();
    for (const body of [
      { game: "chess" },
      { game: "poker", config: { blinds: [1, 2] } },
      { game: "blackjack", config: { boardSkin: "x" } },
    ]) {
      const res = await create(body, t);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
    }
  });
});

describe("GET /v1/rooms/:code", () => {
  it("returns game, seats and taken", async () => {
    const t = await token();
    const res = await create(
      { game: "poker", config: { blinds: [10, 20], boardSkin: "draw" } },
      t,
    );
    const { code } = ((await res.json()) as { data: { code: string } }).data;
    const info = await exports.default.fetch(`${BASE}/v1/rooms/${code}`);
    expect(await info.json()).toEqual({
      data: { code, game: "poker", seats: 6, taken: 0 },
      error: null,
      message: "",
    });
  });

  it.each(["KQ7XZ", "AB0O1"])("returns ROOM_NOT_FOUND for %s", async (code) => {
    const res = await exports.default.fetch(`${BASE}/v1/rooms/${code}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  it("ws upgrade to a room that was never created is ROOM_NOT_FOUND", async () => {
    const res = await exports.default.fetch(`${BASE}/v1/rooms/KQ7XZ/ws`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });
});
