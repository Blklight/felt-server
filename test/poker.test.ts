import { describe, expect, it } from "vitest";
import type { Rng } from "../src/engine/blackjack";
import {
  act,
  buildPots,
  legalActions,
  newPokerGame,
  type PokerGame,
  startHand,
  timeout,
} from "../src/engine/poker";

const creator = { skinId: "classic", backId: "ink" };
const noShuffle: Rng = (n) => n - 1; // keeps order; the button lands on the last player
const BURN = ["8s", "8h", "8d"];

function ok(r: { game: PokerGame } | { error: string }): PokerGame {
  if ("error" in r) throw new Error(r.error);
  return r.game;
}
const go = (g: PokerGame, seat: number, type: string, amount?: number) =>
  ok(act(g, seat, { type, amount }));

// Deal order: from the seat left of the button, two rounds; then burn+flop, burn+turn, burn+river.
const deckFor = (hole: string[], board: string[]) => [
  ...hole,
  BURN[0] as string,
  ...board.slice(0, 3),
  BURN[1] as string,
  board[3] as string,
  BURN[2] as string,
  board[4] as string,
];

function start(
  stacks: number[],
  cards: string[],
  cap = false,
  blinds: [number, number] = [10, 20],
) {
  const seated = stacks.map((stack, seat) => ({ seat, stack, ...creator }));
  return startHand(
    newPokerGame(),
    seated,
    blinds,
    cap,
    noShuffle,
    "creator",
    creator,
    cards,
  );
}

describe("hand start", () => {
  // 3 players: button = seat 2, sb = seat 0, bb = seat 1, first to act = seat 2
  const cards = deckFor(
    ["As", "Kd", "Qd", "Ah", "Kc", "Qc"],
    ["2c", "7d", "9h", "3s", "4d"],
  );

  it("posts blinds, deals from the left of the button, UTG acts first", () => {
    const g = start([1000, 1000, 1000], cards);
    expect(g).toMatchObject({
      phase: "preflop",
      button: 2,
      sb: 0,
      bb: 1,
      turn: 2,
      currentBet: 20,
    });
    expect(g.players.map((p) => [p.bet, p.stack])).toEqual([
      [10, 990],
      [20, 980],
      [0, 1000],
    ]);
    expect(g.players[0]?.cards).toEqual(["As", "Ah"]);
    expect(g.players[2]?.cards).toEqual(["Qd", "Qc"]);
    expect(g.board).toEqual([]);
    expect(legalActions(g, 2)).toEqual([
      { type: "fold" },
      { type: "call", amount: 20 },
      { type: "raise", min: 40, max: 1000 },
    ]);
    expect(legalActions(g, 0)).toEqual([]); // not their turn
  });

  it("heads-up: the button is the small blind and acts first preflop", () => {
    const g = start(
      [1000, 1000],
      ["As", "Kd", "Ah", "Kc", "8s", "2c", "7d", "9h", "8h", "3s", "8d", "4d"],
    );
    expect(g).toMatchObject({ button: 1, sb: 1, bb: 0, turn: 1 });
  });

  it("needs two players with chips", () => {
    expect(start([1000, 0], []).phase).toBe("waiting");
  });

  it("a short stack posts what it has and is all-in", () => {
    const g = start([5, 1000, 1000], cards);
    expect(g.players[0]).toMatchObject({ bet: 5, stack: 0, status: "all-in" });
  });
});

describe("betting rules", () => {
  const cards = deckFor(
    ["As", "Kd", "Qd", "Ah", "Kc", "Qc"],
    ["2c", "7d", "9h", "3s", "4d"],
  );

  it("refuses illegal moves without changing the game", () => {
    const g = start([1000, 1000, 1000], cards);
    const cases: [number, string, number | undefined, string][] = [
      [0, "fold", undefined, "NOT_YOUR_TURN"],
      [2, "check", undefined, "ILLEGAL_ACTION"], // facing the big blind
      [2, "raise", 30, "ILLEGAL_ACTION"], // below the minimum
      [2, "raise", undefined, "ILLEGAL_ACTION"],
      [2, "raise", 1001, "INSUFFICIENT_FUNDS"],
      [2, "dance", undefined, "ILLEGAL_ACTION"],
    ];
    for (const [seat, type, amount, error] of cases) {
      expect(act(g, seat, { type, amount })).toEqual({ error });
    }
    expect(g.turn).toBe(2);
  });

  it("everyone folds to the big blind: uncontested win, cards not revealed", () => {
    let g = start([1000, 1000, 1000], cards);
    g = go(g, 2, "fold");
    g = go(g, 0, "fold");
    expect(g.phase).toBe("showdown");
    expect(g.result).toEqual({
      winners: [{ seat: 1, amount: 30 }],
      revealed: [],
    });
    expect(g.players.map((p) => p.stack)).toEqual([990, 1010, 1000]);
  });

  it("the big blind has an option to raise after everyone calls", () => {
    let g = start([1000, 1000, 1000], cards);
    g = go(g, 2, "call");
    g = go(g, 0, "call");
    expect(g.phase).toBe("preflop");
    expect(g.turn).toBe(1);
    expect(legalActions(g, 1).map((a) => a.type)).toEqual([
      "fold",
      "check",
      "raise",
    ]);
  });

  it("a raise sets the next minimum raise; burned cards never reach the board", () => {
    let g = start([1000, 1000, 1000], cards);
    g = go(g, 2, "raise", 100); // raise by 80
    expect(legalActions(g, 0).find((a) => a.type === "raise")).toMatchObject({
      min: 180,
      max: 1000,
    });
    g = go(g, 0, "call");
    g = go(g, 1, "call");
    expect(g.phase).toBe("flop");
    expect(g.board).toEqual(["2c", "7d", "9h"]);
    expect(g.currentBet).toBe(0);
    expect(g.turn).toBe(0); // first active seat left of the button
    expect(buildPots(g.players, true).map((p) => p.amount)).toEqual([300]);
    expect(legalActions(g, 0).find((a) => a.type === "bet")).toMatchObject({
      min: 20,
      max: 900,
    });
  });
});

describe("showdown", () => {
  it("heads-up checked down: best hand wins, board skips burns", () => {
    let g = start(
      [1000, 1000],
      deckFor(["As", "Kd", "Ah", "Kc"], ["2c", "7d", "9h", "3s", "4d"]),
    );
    g = go(g, 1, "call"); // button/small blind completes
    g = go(g, 0, "check");
    for (const street of ["flop", "turn", "river"]) {
      expect(g.phase).toBe(street);
      g = go(g, 0, "check");
      g = go(g, 1, "check");
    }
    expect(g.phase).toBe("showdown");
    expect(g.board).toEqual(["2c", "7d", "9h", "3s", "4d"]);
    expect(g.result?.revealed).toEqual([0, 1]);
    expect(g.result?.winners).toEqual([
      { seat: 0, amount: 40, hand: { rank: "pair", cards: expect.any(Array) } },
    ]);
    expect(g.players.map((p) => p.stack)).toEqual([1020, 980]);
  });

  it("all-in preflop runs the board out in one go", () => {
    let g = start(
      [500, 500],
      deckFor(["As", "Kd", "Ah", "Kc"], ["2c", "7d", "9h", "3s", "4d"]),
    );
    g = go(g, 1, "all-in");
    g = go(g, 0, "call"); // 480 left <= to call 480: all-in call
    expect(g.phase).toBe("showdown");
    expect(g.board).toHaveLength(5);
    expect(g.players.map((p) => p.stack)).toEqual([1000, 0]);
  });

  it("side pots: each pot goes to the best hand among those eligible", () => {
    // seat0 100 (best hand), seat1 300 (second), seat2 300 (worst)
    let g = start(
      [100, 300, 300],
      deckFor(
        ["As", "Kd", "Qd", "Ah", "Kc", "Qc"],
        ["2c", "7d", "9h", "3s", "4d"],
      ),
    );
    g = go(g, 2, "all-in");
    g = go(g, 0, "all-in");
    g = go(g, 1, "all-in");
    expect(g.phase).toBe("showdown");
    expect(g.players.map((p) => p.stack)).toEqual([300, 400, 0]);
    expect(g.result?.winners.map((w) => [w.seat, w.amount])).toEqual([
      [0, 300],
      [1, 400],
    ]);
  });

  it("a split pot divides evenly", () => {
    let g = start(
      [1000, 1000],
      deckFor(["2s", "3d", "2h", "3c"], ["Ts", "Js", "Qs", "Ks", "As"]),
    );
    g = go(g, 1, "call");
    g = go(g, 0, "check");
    for (let i = 0; i < 3; i++) {
      g = go(g, 0, "check");
      g = go(g, 1, "check");
    }
    expect(g.players.map((p) => p.stack)).toEqual([1000, 1000]);
    expect(g.result?.winners.map((w) => w.amount)).toEqual([20, 20]);
  });
});

describe("capToShortestStack", () => {
  it("nobody can put in more than the shortest stack", () => {
    const g = start(
      [500, 1000, 1000],
      deckFor(
        ["As", "Kd", "Qd", "Ah", "Kc", "Qc"],
        ["2c", "7d", "9h", "3s", "4d"],
      ),
      true,
    );
    expect(g.cap).toBe(500);
    expect(legalActions(g, 2).find((a) => a.type === "raise")).toMatchObject({
      max: 500,
    });
  });
});

describe("timeout", () => {
  const cards = deckFor(
    ["As", "Kd", "Qd", "Ah", "Kc", "Qc"],
    ["2c", "7d", "9h", "3s", "4d"],
  );
  it("folds when facing a bet, checks when free", () => {
    let g = start([1000, 1000, 1000], cards);
    g = ok(timeout(g));
    expect(g.players[2]?.status).toBe("folded");
    g = go(g, 0, "call");
    g = ok(timeout(g)); // big blind may check
    expect(g.phase).toBe("flop");
    expect(g.players[1]?.status).toBe("active");
  });
});

describe("property: random play conserves chips and always finishes", () => {
  const seeded = (seed: number): Rng => {
    let a = seed;
    return (n) => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
  };

  it("400 random hands", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rng = seeded(seed);
      const n = 2 + rng(5);
      const stacks = Array.from({ length: n }, () => 20 + rng(2000));
      const sum = stacks.reduce((a, b) => a + b, 0);
      const seated = stacks.map((stack, i) => ({
        seat: i * 2,
        stack,
        ...creator,
      }));
      let g = startHand(
        newPokerGame(),
        seated,
        [10, 20],
        rng(2) === 0,
        rng,
        "draw",
        creator,
      );
      let guard = 0;
      while (g.phase !== "showdown" && guard++ < 300) {
        const seat = g.turn as number;
        const legal = legalActions(g, seat);
        expect(legal.length).toBeGreaterThan(0);
        const pick = legal[rng(legal.length)] as (typeof legal)[number];
        const amount =
          pick.min !== undefined && pick.max !== undefined
            ? pick.min + rng(pick.max - pick.min + 1)
            : undefined;
        g = ok(act(g, seat, { type: pick.type, amount }));
        // once paid out, `committed` is history, so only mid-hand states count it
        if (g.phase !== "showdown") {
          expect(g.players.reduce((s, p) => s + p.stack + p.committed, 0)).toBe(
            sum,
          );
        }
      }
      expect(g.phase).toBe("showdown");
      expect(g.players.reduce((s, p) => s + p.stack, 0)).toBe(sum);
      expect(g.board.length === 0 || [3, 4, 5].includes(g.board.length)).toBe(
        true,
      );
      expect(
        g.result?.winners.reduce((s, w) => s + w.amount, 0),
      ).toBeGreaterThan(0);
    }
  });
});
