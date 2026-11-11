import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { total } from "../src/engine/blackjack";

const BASE = "https://felt.test";

type Seat = {
  seat: number;
  cards: string[];
  bet: number;
  stack: number;
  total?: number;
  outcome?: { kind: string; amount: number };
};
type View = {
  handId: number;
  phase: string;
  seats: Seat[];
  board: string[];
  dealerTotal?: number;
  secondsLeft: number | null;
  you: {
    seat: number | null;
    legalActions: { type: string; min?: number; max?: number }[];
  };
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

const bet = (amount: number) => ({
  t: "action",
  action: { type: "bet", amount },
});
const hit = { t: "action", action: { type: "hit" } };

// Real RNG: retry with fresh rooms until the first deal leaves the player a decision.
async function startRound() {
  for (let i = 0; i < 40; i++) {
    const token = await signUp();
    const spectatorToken = await signUp();
    const { code } = (
      await api(
        "/v1/rooms",
        { method: "POST", body: JSON.stringify({ game: "blackjack" }) },
        token,
      )
    ).data as { code: string };
    const player = await join(code, token);
    const spectator = await join(code, spectatorToken);
    player.send({ t: "sit", seat: 0, buyIn: 1000 });
    await player.next();
    await spectator.next();
    player.send(bet(100));
    const view = (await player.next()).view as View;
    const seen = (await spectator.next()).view as View;
    if (view.phase === "players")
      return { code, token, player, spectator, view, seen };
    player.ws.close();
    spectator.ws.close();
  }
  throw new Error("never got a hand with a decision");
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

describe("blackjack over WebSocket", () => {
  it("a seated player in an empty round may bet; bad bets and moves are refused", async () => {
    const token = await signUp();
    const { code } = (
      await api(
        "/v1/rooms",
        { method: "POST", body: JSON.stringify({ game: "blackjack" }) },
        token,
      )
    ).data as { code: string };
    const p = await join(code, token);
    p.send({ t: "sit", seat: 0, buyIn: 1000 });
    const waiting = (await p.next()).view as View;
    expect(waiting.phase).toBe("waiting");
    expect(waiting.you.legalActions).toEqual([
      { type: "bet", min: 10, max: 500 },
    ]);
    for (const [msg, code] of [
      [bet(5), "ILLEGAL_ACTION"],
      [bet(501), "ILLEGAL_ACTION"],
      [hit, "ILLEGAL_ACTION"],
      [{ t: "action", action: { type: "bet" } }, "ILLEGAL_ACTION"],
      [{ t: "action", action: { type: "fold" } }, "ILLEGAL_ACTION"],
    ] as const) {
      p.send(msg);
      expect((await p.next()).code).toBe(code);
    }
    p.send(bet(600)); // over the stack too
    expect((await p.next()).code).toBe("ILLEGAL_ACTION");
    p.ws.close();
  });

  it("deals, hides the hole card from everyone, and never exposes the deck", async () => {
    const { player, spectator, view, seen } = await startRound();
    for (const v of [view, seen]) {
      expect(v.board).toHaveLength(2);
      expect(v.board[1]).toBe("??");
      expect(v.dealerTotal).toBe(total([v.board[0] as string]));
      expect(v.seats[0]?.cards).toHaveLength(2);
      expect(v.seats[0]).toMatchObject({ bet: 100, stack: 900 });
      expect(v.secondsLeft).toBeGreaterThan(0);
    }
    expect(JSON.stringify(view)).not.toMatch(/deck/);
    expect(view.you.legalActions.map((a) => a.type)).toEqual([
      "hit",
      "stand",
      "double",
    ]);
    expect(seen.you.legalActions).toEqual([]); // spectator
    expect(seen.you.seat).toBeNull();
    player.ws.close();
    spectator.ws.close();
  });

  it("cannot stand mid-hand; stand ends it; the hole card is shown and chips settle", async () => {
    const { code, token, player, view } = await startRound();
    expect(view.phase).toBe("players");
    player.send({ t: "stand" });
    expect((await player.next()).code).toBe("ILLEGAL_ACTION");

    player.send({ t: "action", action: { type: "stand" } });
    const done = (await player.next()).view as View;
    expect(done.phase).toBe("results");
    expect(done.board.length).toBeGreaterThanOrEqual(2);
    expect(done.board).not.toContain("??");
    const mine = done.seats[0] as Seat;
    expect(mine.outcome).toBeDefined();
    expect(mine.stack).toBe(900 + 100 + (mine.outcome?.amount ?? 0));
    expect(done.you.legalActions).toEqual([]);

    player.send({ t: "stand" });
    expect((await player.next()).view?.you.seat).toBeNull();
    expect(await balance(token)).toBe(5000 - 1000 + mine.stack);
    expect(code).toBeTruthy();
    player.ws.close();
  });

  it("timer: auto-stand, then next betting round, then waiting when nobody bets", async () => {
    const { code, player, view } = await startRound();
    await expire(code); // turn timed out
    const results = (await player.next()).view as View;
    expect(results.phase).toBe("results");
    expect(results.handId).toBe(view.handId);

    await expire(code); // results over -> betting
    const betting = (await player.next()).view as View;
    expect(betting.phase).toBe("betting");
    expect(betting.handId).toBe(view.handId + 1);
    expect(betting.you.legalActions[0]?.type).toBe("bet");
    expect(betting.seats[0]?.cards).toEqual([]);

    await expire(code); // nobody bet -> waiting
    const waiting = (await player.next()).view as View;
    expect(waiting.phase).toBe("waiting");
    expect(waiting.secondsLeft).toBeNull();
    player.ws.close();
  });

  it("hitting changes only the actor's hand", async () => {
    const { player, view } = await startRound();
    player.send(hit);
    const after = (await player.next()).view as View;
    expect(after.seats[0]?.cards.slice(0, 2)).toEqual(view.seats[0]?.cards);
    expect(after.seats[0]?.cards.length).toBeGreaterThanOrEqual(3);
    expect(after.handId).toBe(view.handId);
    player.ws.close();
  });
});
