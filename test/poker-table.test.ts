import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://felt.test";

type Seat = {
  seat: number;
  cards: string[];
  bet: number;
  stack: number;
  status: string;
  leaving?: boolean;
};
type View = {
  handId: number;
  phase: string;
  seats: Seat[];
  board: string[];
  pots: number[];
  secondsLeft: number | null;
  secondsTotal?: number;
  you: {
    seat: number | null;
    legalActions: { type: string }[];
    hand?: { rank: string };
  };
  result?: { winners: { seat: number; amount: number; hand?: unknown }[] };
};
type Msg = { t: string; code?: string; view?: View };

const api = async (path: string, init: RequestInit = {}, token?: string) =>
  (await exports.default
    .fetch(`${BASE}${path}`, {
      ...init,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    .then((r) => r.json())) as { data: Record<string, unknown> };

const signUp = async () =>
  (
    await api("/v1/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "Ana" }),
    })
  ).data.token as string;
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
  await next();
  return { ws, next, send };
}
type Client = Awaited<ReturnType<typeof join>>;

const action = (type: string, amount?: number) => ({
  t: "action",
  action: { type, amount },
});

// Two players seated at a poker table, plus a spectator; the hand starts when the second one sits.
async function table() {
  const [a, b, s] = [await signUp(), await signUp(), await signUp()];
  const { code } = (
    await api(
      "/v1/rooms",
      { method: "POST", body: JSON.stringify({ game: "poker" }) },
      a,
    )
  ).data as { code: string };
  const [ca, cb, cs] = [
    await join(code, a),
    await join(code, b),
    await join(code, s),
  ];
  ca.send({ t: "sit", seat: 0, buyIn: 1000 });
  await ca.next();
  await cb.next();
  await cs.next(); // everyone sees Ana sit
  cb.send({ t: "sit", seat: 1, buyIn: 1000 });
  const views = [
    (await ca.next()).view as View,
    (await cb.next()).view as View,
    (await cs.next()).view as View,
  ];
  return {
    code,
    tokens: [a, b],
    clients: [ca, cb],
    spectator: cs,
    views: views as [View, View, View],
  };
}

const stubOf = (code: string) => env.TABLE.get(env.TABLE.idFromName(code));
async function expire(code: string) {
  const stub = stubOf(code);
  await runInDurableObject(stub, (_i, state) => {
    const row = state.storage.sql
      .exec<{ state: string }>("SELECT state FROM snapshot")
      .one();
    const snap = JSON.parse(row.state);
    snap.deadline = 0;
    state.storage.sql.exec(
      "UPDATE snapshot SET state = ?",
      JSON.stringify(snap),
    );
  });
  await runDurableObjectAlarm(stub);
}
const turnOf = (views: View[]) =>
  views.findIndex((v) => v.you.legalActions.length > 0);

describe("poker over WebSocket", () => {
  it("starts when the second player sits; each viewer sees only what they may", async () => {
    const { views, clients, spectator } = await table();
    const [va, vb, vs] = views;
    for (const v of views) {
      expect(v).toMatchObject({ phase: "preflop", handId: 1, board: [] });
      expect(v.secondsLeft).toBeGreaterThan(0);
      expect(JSON.stringify(v)).not.toMatch(/deck|burn/);
    }
    expect(va.seats[0]?.cards.every((c) => c !== "??")).toBe(true);
    expect(va.seats[1]?.cards).toEqual(["??", "??"]);
    expect(vb.seats[1]?.cards.every((c) => c !== "??")).toBe(true);
    expect(vb.seats[0]?.cards).toEqual(["??", "??"]);
    expect(vs.seats.flatMap((s) => s.cards).every((c) => c === "??")).toBe(
      true,
    );
    expect(va.you.hand).toBeDefined();
    expect(vs.you.hand).toBeUndefined();
    expect(vs.you.legalActions).toEqual([]);
    // blinds are in front of the players, not yet in a pot
    expect(va.seats.map((s) => s.bet).sort()).toEqual(
      [0, 0, 0, 0, 25, 50].sort(),
    );
    expect(va.pots).toEqual([]);
    for (const c of clients) c.ws.close();
    spectator.ws.close();
  });

  it("wrong player gets NOT_YOUR_TURN; leaving mid-hand waits for the hand to end", async () => {
    const { views, clients, spectator, tokens } = await table();
    expect(views[0].secondsTotal).toBe(30);
    const t = turnOf(views);
    const other = 1 - t;
    const [mover, leaver] = [clients[t] as Client, clients[other] as Client];
    leaver.send(action("check"));
    expect(((await leaver.next()) as Msg).code).toBe("NOT_YOUR_TURN");
    leaver.send({ t: "stand" });
    const marked = (await leaver.next()).view as View;
    await mover.next();
    await spectator.next();
    expect(marked.you.seat).toBe(other);
    expect(marked.seats[other]?.leaving).toBe(true);

    mover.send(action("fold"));
    const after = (await mover.next()).view as View;
    expect(after.seats[other]?.status).toBe("empty");
    expect(
      (await balance(tokens[other] as string)) + (after.seats[t] as Seat).stack,
    ).toBe(6000);
    for (const c of clients) c.ws.close();
    spectator.ws.close();
  });

  it("fold ends the hand without revealing cards; chips and ledger add up", async () => {
    const { views, clients, spectator, tokens } = await table();
    const t = turnOf(views);
    (clients[t] as Client).send(action("fold"));
    const after = (await (clients[0] as Client).next()).view as View;
    const afterB = (await (clients[1] as Client).next()).view as View;
    expect(after.phase).toBe("showdown");
    expect(after.pots).toEqual([]);
    expect(after.result?.winners).toHaveLength(1);
    expect(after.result?.winners[0]?.hand).toBeUndefined();
    // nobody's cards were shown: the folder's view of the winner is closed, and the folded hand is gone
    const [folder, winner] = t === 0 ? [after, afterB] : [afterB, after];
    expect(folder.seats[1 - t]?.cards).toEqual(["??", "??"]);
    expect(winner.seats[t]?.cards).toEqual([]);
    expect(after.seats.reduce((s, x) => s + x.stack, 0)).toBe(2000);

    // leaving after the hand cashes out the stack
    for (const [i, c] of clients.entries()) {
      c.send({ t: "stand" });
      await c.next();
      void i;
    }
    expect(
      (await balance(tokens[0] as string)) +
        (await balance(tokens[1] as string)),
    ).toBe(10000);
    for (const c of clients) c.ws.close();
    spectator.ws.close();
  });

  it("checked/called down to showdown: both hands are revealed and the winner is paid", async () => {
    const { views, clients, spectator } = await table();
    let latest = views.slice(0, 2) as View[];
    for (
      let guard = 0;
      guard < 30 && latest[0]?.phase !== "showdown";
      guard++
    ) {
      const t = turnOf(latest);
      const legal = (latest[t] as View).you.legalActions.map((a) => a.type);
      (clients[t] as Client).send(
        action(legal.includes("check") ? "check" : "call"),
      );
      latest = [
        (await (clients[0] as Client).next()).view as View,
        (await (clients[1] as Client).next()).view as View,
      ];
      await spectator.next();
    }
    const [va, vb] = latest as [View, View];
    expect(va.phase).toBe("showdown");
    expect(va.board).toHaveLength(5);
    for (const v of [va, vb]) {
      expect(
        v.seats.slice(0, 2).every((s) => s.cards.every((c) => c !== "??")),
      ).toBe(true);
      expect(v.result?.winners.length).toBeGreaterThan(0);
      expect(v.result?.winners.every((w) => w.hand)).toBe(true);
    }
    expect(va.seats.reduce((s, x) => s + x.stack, 0)).toBe(2000);
    for (const c of clients) c.ws.close();
    spectator.ws.close();
  });

  it("timer: auto-fold facing a bet, then the next hand starts with the button moved", async () => {
    const { code, views, clients, spectator } = await table();
    const button = views[0].seats.findIndex(
      (s) =>
        s.cards.length > 0 && (s as Seat & { isDealer?: boolean }).isDealer,
    );
    await expire(code);
    const a1 = (await (clients[0] as Client).next()).view as View;
    await (clients[1] as Client).next();
    expect(a1.phase).toBe("showdown");
    await expire(code);
    const a2 = (await (clients[0] as Client).next()).view as View;
    await (clients[1] as Client).next();
    expect(a2).toMatchObject({ phase: "preflop", handId: 2 });
    const dealer = a2.seats.findIndex(
      (s) => (s as Seat & { isDealer?: boolean }).isDealer,
    );
    expect(dealer).not.toBe(button);
    for (const c of clients) c.ws.close();
    spectator.ws.close();
  });

  it("a lone player waits; the first hand never starts", async () => {
    const t = await signUp();
    const { code } = (
      await api(
        "/v1/rooms",
        { method: "POST", body: JSON.stringify({ game: "poker" }) },
        t,
      )
    ).data as { code: string };
    const p = await join(code, t);
    p.send({ t: "sit", seat: 3, buyIn: 1000 });
    const v = (await p.next()).view as View;
    expect(v.phase).toBe("waiting");
    expect(v.secondsLeft).toBeNull();
    expect(v.you.legalActions).toEqual([]);
    p.ws.close();
  });
});
