import { describe, expect, it } from "vitest";
import {
  act,
  allBet,
  deal,
  type Game,
  inRound,
  legalActions,
  newGame,
  placeBet,
  type Rng,
  startBetting,
  total,
} from "../src/engine/blackjack";

const creator = { skinId: "classic", backId: "ink" };
const noShuffle: Rng = (n) => n - 1;
const seated = (...stacks: number[]) =>
  stacks.map((stack, seat) => ({ seat, stack, ...creator }));

function ok(r: { game: Game } | { error: string }): Game {
  if ("error" in r) throw new Error(r.error);
  return r.game;
}

// Deal order: each player, dealer, each player, dealer (hole), then draws.
function round(stacks: number[], bets: number[], deck: string[]) {
  let g = startBetting(
    newGame(),
    seated(...stacks),
    noShuffle,
    "creator",
    creator,
  );
  for (const [seat, bet] of bets.entries()) g = ok(placeBet(g, seat, bet));
  return deal(g, noShuffle, deck);
}

describe("total", () => {
  it.each([
    [["As", "Kd"], 21],
    [["As", "Ad"], 12],
    [["As", "5d", "9c"], 15],
    [["Ts", "5d", "9c"], 24],
    [["As", "As", "9c"], 21],
  ])("%j = %i", (cards, expected) => expect(total(cards)).toBe(expected));
});

describe("betting", () => {
  it("validates bets and keeps the game unchanged on error", () => {
    const g = startBetting(
      newGame(),
      seated(5000, 50),
      noShuffle,
      "creator",
      creator,
    );
    expect(placeBet(g, 0, 9)).toEqual({ error: "ILLEGAL_ACTION" });
    expect(placeBet(g, 0, 501)).toEqual({ error: "ILLEGAL_ACTION" });
    expect(placeBet(g, 1, 100)).toEqual({ error: "INSUFFICIENT_FUNDS" });
    expect(placeBet(g, 5, 100)).toEqual({ error: "ILLEGAL_ACTION" });
    expect(g.hands[0]).toMatchObject({ stack: 5000, bet: 0 });
    const g2 = ok(placeBet(g, 0, 100));
    expect(placeBet(g2, 0, 100)).toEqual({ error: "ILLEGAL_ACTION" }); // twice
    expect(g2.hands[0]).toMatchObject({ stack: 4900, bet: 100 });
  });

  it("stays waiting when nobody can bet; a short stack sits out", () => {
    const empty = startBetting(
      newGame(),
      seated(5),
      noShuffle,
      "creator",
      creator,
    );
    expect(empty.phase).toBe("waiting");
    const g = startBetting(
      newGame(),
      seated(5, 100),
      noShuffle,
      "creator",
      creator,
    );
    expect(g.hands[0]?.state).toBe("idle");
    expect(legalActions(g, 0, 5)).toEqual([]);
    expect(legalActions(g, 1, 100)).toEqual([
      { type: "bet", min: 10, max: 100 },
    ]);
  });

  it("draws the board skin from a seated player", () => {
    const players = [
      { seat: 0, stack: 500, skinId: "noir", backId: "neon" },
      { seat: 1, stack: 500, skinId: "vice", backId: "suits" },
    ];
    const g = startBetting(newGame(), players, () => 1, "draw", creator);
    expect(g.board).toEqual({ skinId: "vice", backId: "suits" });
  });

  it("deals when everyone bet; non-bettors are out", () => {
    let g = startBetting(
      newGame(),
      seated(500, 500),
      noShuffle,
      "creator",
      creator,
    );
    g = ok(placeBet(g, 0, 50));
    expect(allBet(g)).toBe(false);
    g = deal(g, noShuffle);
    expect(g.hands[1]?.state).toBe("idle");
    expect(g.hands[0]?.cards).toHaveLength(2);
  });

  it("nobody bet -> back to waiting", () => {
    const g = startBetting(
      newGame(),
      seated(500),
      noShuffle,
      "creator",
      creator,
    );
    expect(deal(g, noShuffle).phase).toBe("waiting");
  });
});

describe("play", () => {
  // p0: 9s 8s (17), dealer: Ts 7d (17) hidden 7d
  it("stand, dealer stands on 17, push", () => {
    let g = round([1000], [100], ["9s", "Ts", "8s", "7d"]);
    expect(g.phase).toBe("players");
    expect(legalActions(g, 0, 900)).toEqual([
      { type: "hit" },
      { type: "stand" },
      { type: "double", amount: 100 },
    ]);
    g = ok(act(g, 0, "stand"));
    expect(g.phase).toBe("results");
    expect(g.hands[0]).toMatchObject({
      stack: 1000,
      outcome: { kind: "push" },
    });
  });

  it("natural pays 3:2 and floors odd amounts", () => {
    const g = round([1000], [15], ["As", "9s", "Kd", "8d"]);
    expect(g.phase).toBe("results");
    expect(g.hands[0]?.outcome).toEqual({ kind: "blackjack", amount: 22 });
    expect(g.hands[0]?.stack).toBe(1000 + 22);
  });

  it("dealer natural: players lose, natural pushes, no draws", () => {
    const g = round(
      [1000, 1000, 1000],
      [100, 100, 100],
      ["As", "9s", "Ts", "Ah", "Kd", "Td", "Kh", "Qs"],
    );
    expect(g.phase).toBe("results");
    expect(g.hands.map((h) => h.outcome?.kind)).toEqual([
      "push",
      "lose",
      "lose",
    ]);
    expect(g.hands.map((h) => h.stack)).toEqual([1000, 900, 900]);
    expect(g.dealer).toHaveLength(2);
  });

  it("bust loses, dealer does not draw when all busted", () => {
    let g = round([1000], [100], ["Ts", "9s", "6d", "8d", "9c"]);
    g = ok(act(g, 0, "hit")); // 25
    expect(g.phase).toBe("results");
    expect(g.hands[0]).toMatchObject({
      stack: 900,
      outcome: { kind: "bust", amount: -100 },
    });
    expect(g.dealer).toHaveLength(2);
  });

  it("dealer draws to 17 and busts", () => {
    // p0 Ts 8d (18) stands; dealer 6s Th 6c? deal order: p0 Ts, dealer 6s, p0 8d, dealer Th, draw 9c
    let g = round([1000], [100], ["Ts", "6s", "8d", "Th", "9c"]);
    g = ok(act(g, 0, "stand"));
    expect(g.dealer).toEqual(["6s", "Th", "9c"]);
    expect(g.hands[0]).toMatchObject({
      stack: 1100,
      outcome: { kind: "win", amount: 100 },
    });
  });

  it("double: one card, doubled bet, then stands", () => {
    // p0 5s 6d = 11, dealer Ts 8s; double draws 9c = 20; dealer 18
    let g = round([1000], [100], ["5s", "Ts", "6d", "8s", "9c"]);
    g = ok(act(g, 0, "double"));
    expect(g.hands[0]).toMatchObject({ bet: 200, state: "stood" });
    expect(g.hands[0]?.outcome).toEqual({ kind: "win", amount: 200 });
    expect(g.hands[0]?.stack).toBe(1200);
  });

  it("double needs two cards and enough chips", () => {
    let g = round([150], [100], ["2s", "Ts", "3d", "8s", "2c", "9c"]);
    expect(act(g, 0, "double")).toEqual({ error: "INSUFFICIENT_FUNDS" });
    g = ok(act(g, 0, "hit"));
    expect(act(g, 0, "double")).toEqual({ error: "ILLEGAL_ACTION" });
  });

  it("turn order: NOT_YOUR_TURN, then the next player acts", () => {
    let g = round(
      [1000, 1000],
      [100, 100],
      ["9s", "9d", "Ts", "8s", "8d", "7d", "9h"],
    );
    expect(g.turn).toBe(0);
    expect(act(g, 1, "hit")).toEqual({ error: "NOT_YOUR_TURN" });
    g = ok(act(g, 0, "stand"));
    expect(g.turn).toBe(1);
    expect(legalActions(g, 0, 900)).toEqual([]);
    expect(inRound(g, 1)).toBe(true);
  });

  it("hitting to 21 stands automatically", () => {
    let g = round([1000], [100], ["5s", "Ts", "6d", "8s", "Tc"]);
    g = ok(act(g, 0, "hit")); // 21
    expect(g.phase).toBe("results");
  });

  it("illegal actions outside the phase change nothing", () => {
    const g = startBetting(
      newGame(),
      seated(500),
      noShuffle,
      "creator",
      creator,
    );
    expect(act(g, 0, "hit")).toEqual({ error: "ILLEGAL_ACTION" });
  });
});

describe("property: chips are conserved and the engine never throws", () => {
  const seeded = (seed: number): Rng => {
    let a = seed;
    return (n) => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
  };

  it("200 random rounds", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = seeded(seed);
      const stacks = [1000, 500, 300].slice(0, 1 + rng(3));
      let g = startBetting(newGame(), seated(...stacks), rng, "draw", creator);
      for (const h of g.hands) g = ok(placeBet(g, h.seat, 10 + rng(100)));
      g = deal(g, rng);
      let guard = 0;
      while (g.phase === "players" && guard++ < 200) {
        const seat = g.turn as number;
        const type = (["hit", "stand", "double"] as const)[rng(3)] as "hit";
        const r = act(g, seat, type);
        if ("game" in r) g = r.game;
      }
      expect(g.phase).toBe("results");
      for (const h of g.hands) {
        expect(h.stack).toBe(
          (stacks[h.seat] as number) + (h.outcome?.amount ?? 0),
        );
        expect(h.stack).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
