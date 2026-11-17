import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://felt.test";

// Loose shape: assertions below check the fields they need.
type Msg = {
  t: string;
  seq: number;
  you: { name: string };
  view: { seats: Record<string, unknown>[] };
};

const post = async (path: string, body: unknown, token?: string) =>
  (await exports.default
    .fetch(`${BASE}${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    })
    .then((r) => r.json())) as { data: { token: string; code: string } };

async function open() {
  const { token } = (await post("/v1/accounts", { name: "Ana" })).data;
  const { code } = (await post("/v1/rooms", { game: "poker" }, token)).data;
  const res = await exports.default.fetch(`${BASE}/v1/rooms/${code}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const messages: Msg[] = [];
  const waiting: ((m: Msg) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string);
    const w = waiting.shift();
    if (w) w(m);
    else messages.push(m);
  });
  const next = () =>
    new Promise<Msg>((r) => {
      const m = messages.shift();
      if (m) r(m);
      else waiting.push(r);
    });
  return { ws, token, code, next };
}

describe("hello", () => {
  it("answers welcome with a spectator view in phase waiting", async () => {
    const { ws, token, next } = await open();
    ws.send(JSON.stringify({ t: "hello", v: 1, token }));
    const msg = await next();
    expect(msg.t).toBe("welcome");
    expect(msg.seq).toBe(0);
    expect(msg.you.name).toBe("Ana");
    expect(msg.view).toMatchObject({
      handId: 0,
      game: "poker",
      phase: "waiting",
      you: { seat: null, legalActions: [] },
      buyIn: { min: 1000, max: 5000 }, // default blinds 25/50
    });
    expect(msg.view.seats).toHaveLength(6);
    for (const seat of msg.view.seats) {
      expect(seat).toMatchObject({ status: "empty", cards: [] });
    }
    ws.close();
  });

  it("reconnecting with the same token works", async () => {
    const first = await open();
    first.ws.close();
    const res = await exports.default.fetch(
      `${BASE}/v1/rooms/${first.code}/ws`,
      { headers: { Upgrade: "websocket" } },
    );
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const reply = new Promise<Msg>((r) =>
      ws.addEventListener("message", (e) => r(JSON.parse(e.data as string)), {
        once: true,
      }),
    );
    ws.send(JSON.stringify({ t: "hello", v: 1, token: first.token }));
    expect((await reply).t).toBe("welcome");
    ws.close();
  });

  it("rejects an unknown token with UNAUTHORIZED and closes", async () => {
    const { ws, next } = await open();
    const closed = new Promise<number>((r) =>
      ws.addEventListener("close", (e) => r(e.code)),
    );
    ws.send(JSON.stringify({ t: "hello", v: 1, token: "A".repeat(43) }));
    expect(await next()).toEqual({ t: "error", code: "UNAUTHORIZED" });
    expect(await closed).toBe(1008);
  });

  it("rejects any message before hello", async () => {
    const { ws, next } = await open();
    ws.send(JSON.stringify({ t: "stand" }));
    expect(await next()).toEqual({ t: "error", code: "UNAUTHORIZED" });
    ws.close();
  });

  it("closes a socket that never says hello once the alarm fires", async () => {
    const { ws, code } = await open();
    const closed = new Promise<number>((r) =>
      ws.addEventListener("close", (e) => r(e.code)),
    );
    const stub = env.TABLE.get(env.TABLE.idFromName(code));
    await runInDurableObject(stub, (_i, state) => {
      for (const s of state.getWebSockets()) {
        s.serializeAttachment({ connectedAt: 0 });
      }
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await closed).toBe(1008);
  });
});

describe("rate limit", () => {
  it("answers RATE_LIMITED past 20 messages per second and drops the rest", async () => {
    const { ws, token, next } = await open();
    ws.send(JSON.stringify({ t: "hello", v: 1, token }));
    await next();
    for (let i = 0; i < 40; i++)
      ws.send(JSON.stringify({ t: "emote", id: "gg" }));
    let echoes = 0;
    let limited = false;
    while (!limited) {
      const m = (await next()) as { t: string; code?: string };
      if (m.t === "echo") echoes++;
      else limited = m.code === "RATE_LIMITED";
    }
    expect(echoes).toBe(19); // hello was the first of the 20
    ws.close();
  });
});
