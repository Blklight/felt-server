import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://felt.test";

type View = {
  seats: {
    seat: number;
    status: string;
    name: string;
    stack: number;
    cards: string[];
  }[];
  you: { seat: number | null };
  buyIn?: { min: number; max: number };
};
type Msg = { t: string; seq?: number; code?: string; view?: View };

const api = async (path: string, init: RequestInit = {}, token?: string) =>
  (await exports.default
    .fetch(`${BASE}${path}`, {
      ...init,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    .then((r) => r.json())) as { data: Record<string, unknown> };

const signUp = async (name: string) =>
  (
    await api("/v1/accounts", {
      method: "POST",
      body: JSON.stringify({ name }),
    })
  ).data as { token: string };

const balance = async (token: string) =>
  (await api("/v1/me", {}, token)).data.balance as number;

async function join(code: string, token: string) {
  const res = await exports.default.fetch(`${BASE}/v1/rooms/${code}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const queue: Msg[] = [];
  const waiting: ((m: Msg) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string) as Msg;
    const w = waiting.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = () =>
    new Promise<Msg>((r) => {
      const m = queue.shift();
      if (m) r(m);
      else waiting.push(r);
    });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  send({ t: "hello", v: 1, token });
  const welcome = await next();
  return { ws, next, send, welcome };
}

async function room(game = "blackjack") {
  const a = await signUp("Ana");
  const { code } = (
    await api(
      "/v1/rooms",
      { method: "POST", body: JSON.stringify({ game }) },
      a.token,
    )
  ).data as { code: string };
  return { code, a };
}

describe("sit / stand", () => {
  it("debits the buy-in, shows the seat to everyone, and cash-out returns it", async () => {
    const { code, a } = await room();
    const b = await signUp("Bia");
    const ana = await join(code, a.token);
    const bia = await join(code, b.token);

    ana.send({ t: "sit", seat: 1, buyIn: 500 });
    const forAna = await ana.next();
    const forBia = await bia.next();
    expect(forAna.view?.you.seat).toBe(1);
    expect(forAna.view?.buyIn).toBeUndefined();
    expect(forBia.view?.you.seat).toBeNull();
    expect(forBia.view?.seats[1]).toMatchObject({
      status: "active",
      name: "Ana",
      stack: 500,
    });
    expect(forBia.seq).toBe(1);
    expect(await balance(a.token)).toBe(4500);

    ana.send({ t: "stand" });
    expect((await ana.next()).view?.you.seat).toBeNull();
    expect((await bia.next()).view?.seats[1]?.status).toBe("empty");
    expect(await balance(a.token)).toBe(5000);
    ana.ws.close();
    bia.ws.close();
  });

  it("rejects bad sits without moving money", async () => {
    const { code, a } = await room();
    const b = await signUp("Bia");
    const ana = await join(code, a.token);
    const bia = await join(code, b.token);
    const cases: [unknown, string][] = [
      [{ t: "sit", seat: 0, buyIn: 100 }, "ILLEGAL_ACTION"], // below 200
      [{ t: "sit", seat: 0, buyIn: 2001 }, "ILLEGAL_ACTION"],
      [{ t: "sit", seat: 5, buyIn: 500 }, "ILLEGAL_ACTION"], // blackjack has 5 seats
    ];
    for (const [msg, expected] of cases) {
      ana.send(msg);
      expect((await ana.next()).code).toBe(expected);
    }
    ana.send({ t: "stand" });
    expect((await ana.next()).code).toBe("ILLEGAL_ACTION"); // not seated

    ana.send({ t: "sit", seat: 0, buyIn: 500 });
    await ana.next();
    await bia.next();
    ana.send({ t: "sit", seat: 1, buyIn: 500 });
    expect((await ana.next()).code).toBe("ILLEGAL_ACTION"); // already seated
    bia.send({ t: "sit", seat: 0, buyIn: 500 });
    expect((await bia.next()).code).toBe("SEAT_TAKEN");
    expect(await balance(b.token)).toBe(5000);
    ana.ws.close();
    bia.ws.close();
  });

  it("refuses a buy-in above the balance", async () => {
    const first = await room("poker");
    const ana = await join(first.code, first.a.token);
    ana.send({ t: "sit", seat: 0, buyIn: 5000 }); // whole balance
    expect((await ana.next()).view?.you.seat).toBe(0);
    expect(await balance(first.a.token)).toBe(0);

    // same account, second room
    const { code } = (
      await api(
        "/v1/rooms",
        { method: "POST", body: JSON.stringify({ game: "blackjack" }) },
        first.a.token,
      )
    ).data as { code: string };
    const again = await join(code, first.a.token);
    again.send({ t: "sit", seat: 0, buyIn: 200 });
    expect((await again.next()).code).toBe("INSUFFICIENT_FUNDS");
    expect((await api(`/v1/rooms/${code}`)).data.taken).toBe(0);
    ana.ws.close();
    again.ws.close();
  });

  it("ROOM_FULL when every seat is taken", async () => {
    const { code, a } = await room();
    const players = [
      a,
      ...(await Promise.all(["P2", "P3", "P4", "P5", "P6"].map(signUp))),
    ];
    const sockets = await Promise.all(players.map((p) => join(code, p.token)));
    for (const [i, s] of sockets.slice(0, 5).entries()) {
      s.send({ t: "sit", seat: i, buyIn: 200 });
      await s.next();
    }
    const last = sockets[5];
    last?.send({ t: "sit", seat: 0, buyIn: 200 });
    // earlier sockets also receive broadcast views; the last socket only gets its own reply
    let m = await last?.next();
    while (m?.t === "view") m = await last?.next();
    expect(m?.code).toBe("ROOM_FULL");
    for (const s of sockets) s.ws.close();
  });

  it("recovers the seat on reconnect", async () => {
    const { code, a } = await room();
    const first = await join(code, a.token);
    first.send({ t: "sit", seat: 2, buyIn: 300 });
    await first.next();
    first.ws.close();
    const again = await join(code, a.token);
    expect(again.welcome.view?.you.seat).toBe(2);
    again.ws.close();
  });
});

describe("disconnect", () => {
  it("frees the seat and cashes out when the alarm finds it expired", async () => {
    const { code, a } = await room();
    const ana = await join(code, a.token);
    ana.send({ t: "sit", seat: 0, buyIn: 400 });
    await ana.next();
    expect(await balance(a.token)).toBe(4600);
    ana.ws.close();
    // let the close reach the Durable Object
    const stub = env.TABLE.get(env.TABLE.idFromName(code));
    for (let i = 0; i < 50; i++) {
      const open = await runInDurableObject(
        stub,
        (_i, state) => state.getWebSockets().length,
      );
      if (open === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE seat SET deadline = 0");
    });
    await runDurableObjectAlarm(stub);
    expect(await balance(a.token)).toBe(5000);
    const info = await api(`/v1/rooms/${code}`);
    expect(info.data.taken).toBe(0);
  });

  it("keeps the seat while the player is back before the deadline", async () => {
    const { code, a } = await room();
    const ana = await join(code, a.token);
    ana.send({ t: "sit", seat: 0, buyIn: 400 });
    await ana.next();
    ana.ws.close();
    const again = await join(code, a.token);
    const stub = env.TABLE.get(env.TABLE.idFromName(code));
    await runDurableObjectAlarm(stub);
    expect(again.welcome.view?.you.seat).toBe(0);
    expect(await balance(a.token)).toBe(4600);
    again.ws.close();
  });
});

describe("idempotency", () => {
  it("settling the same ref twice moves chips once", async () => {
    const { a } = await room();
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(a.token),
    );
    const hash = [...new Uint8Array(bytes)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(hash));
    await stub.settle(-300, "buyin", "buyin:x", Date.now());
    await stub.settle(-300, "buyin", "buyin:x", Date.now());
    expect(await balance(a.token)).toBe(4700);
    expect(await stub.settle(-99999, "buyin", "buyin:y", Date.now())).toEqual({
      error: "INSUFFICIENT_FUNDS",
    });
  });
});

describe("view leak", () => {
  it("no view carries a card for a seat that is not the viewer's", async () => {
    const { code, a } = await room();
    const b = await signUp("Bia");
    const ana = await join(code, a.token);
    const bia = await join(code, b.token);
    ana.send({ t: "sit", seat: 0, buyIn: 500 });
    const views = [(await ana.next()).view, (await bia.next()).view];
    for (const view of views) {
      expect(view?.seats.every((s) => s.cards.length === 0)).toBe(true);
    }
    ana.ws.close();
    bia.ws.close();
  });
});

describe("name lock", () => {
  const rename = (token: string, body: unknown) =>
    exports.default.fetch(`${BASE}/v1/me`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("cannot edit the profile while seated; resending current values is fine; free after standing", async () => {
    const { code, a } = await room();
    const ana = await join(code, a.token);
    ana.send({ t: "sit", seat: 0, buyIn: 300 });
    await ana.next();

    const locked = await rename(a.token, { name: "Novo" });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", fields: { name: "locked" } },
    });
    expect((await rename(a.token, { name: "Ana" })).status).toBe(200);
    const skin = await rename(a.token, { skinId: "noir", avatarId: "a2" });
    expect(skin.status).toBe(409);
    expect(await skin.json()).toMatchObject({
      error: { fields: { skinId: "locked", avatarId: "locked" } },
    });
    expect((await rename(a.token, { skinId: "classic" })).status).toBe(200); // unchanged

    ana.send({ t: "stand" });
    await ana.next();
    expect(
      (await rename(a.token, { name: "Novo", skinId: "noir" })).status,
    ).toBe(200);
    ana.ws.close();
  });
});
