// Pure Texas Hold'em engine: no I/O, no clock, no Math.random. The RNG comes in as a parameter.
import type { ErrorCode, HandInfo, LegalAction, Winner } from "../protocol";
import { type Rng, shuffle } from "./blackjack";
import { bestHand, compare } from "./handEval";

export type PStatus = "active" | "folded" | "all-in";

export type PPlayer = {
  seat: number;
  stack: number; // chips behind
  bet: number; // put in this street
  committed: number; // put in this hand
  cards: string[];
  status: PStatus;
  acted: boolean;
  skinId: string;
  backId: string;
};

export type PokerPhase =
  | "waiting"
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown";

export type PokerGame = {
  handId: number;
  phase: PokerPhase;
  deck: string[]; // never leaves the server (burned cards are dropped from it)
  board: string[];
  players: PPlayer[]; // seat order, only those dealt into the hand
  button: number | null;
  sb: number | null;
  bb: number | null;
  blinds: [number, number];
  turn: number | null;
  currentBet: number; // highest bet this street
  minRaise: number; // size of the last full raise
  cap: number | null; // capToShortestStack: most anyone may put in this hand
  result: { winners: Winner[]; revealed: number[] } | null;
  boardSkin: { skinId: string; backId: string } | null;
};

export type PSeated = {
  seat: number;
  stack: number;
  skinId: string;
  backId: string;
};

type Result = { game: PokerGame } | { error: ErrorCode };

export const newPokerGame = (): PokerGame => ({
  handId: 0,
  phase: "waiting",
  deck: [],
  board: [],
  players: [],
  button: null,
  sb: null,
  bb: null,
  blinds: [10, 20],
  turn: null,
  currentBet: 0,
  minRaise: 0,
  cap: null,
  result: null,
  boardSkin: null,
});

const deck52 = () =>
  [..."A23456789TJQK"].flatMap((r) => [..."shdc"].map((s) => r + s));

const canAct = (p: PPlayer) => p.status === "active";
const player = (g: PokerGame, seat: number) =>
  g.players.find((p) => p.seat === seat);

// First player strictly after `from` (seat order, wrapping) that satisfies `pred`.
function seatAfter(g: PokerGame, from: number, pred: (p: PPlayer) => boolean) {
  const n = g.players.length;
  const start = g.players.findIndex((p) => p.seat > from);
  for (let i = 0; i < n; i++) {
    const p = g.players[((start < 0 ? 0 : start) + i) % n] as PPlayer;
    if (pred(p)) return p.seat;
  }
  return null;
}

function put(g: PokerGame, p: PPlayer, amount: number) {
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.bet += a;
  p.committed += a;
  if (p.stack === 0 || (g.cap !== null && p.committed >= g.cap))
    p.status = "all-in";
}

export function startHand(
  g: PokerGame,
  seated: PSeated[],
  blinds: [number, number],
  capToShortestStack: boolean,
  rng: Rng,
  boardSkin: "creator" | "draw",
  creator: { skinId: string; backId: string },
  cards = shuffle(deck52(), rng), // a parameter so tests can stack the deck
): PokerGame {
  const dealt = seated
    .filter((s) => s.stack > 0)
    .sort((a, b) => a.seat - b.seat);
  if (dealt.length < 2) {
    return {
      ...g,
      phase: "waiting",
      deck: [],
      board: [],
      players: [],
      turn: null,
      result: null,
      boardSkin: null,
    };
  }
  const players: PPlayer[] = dealt.map((s) => ({
    ...s,
    bet: 0,
    committed: 0,
    cards: [],
    status: "active",
    acted: false,
  }));
  const button =
    g.button === null
      ? (players[rng(players.length)] as PPlayer).seat
      : (
          players.find((p) => p.seat > (g.button as number)) ??
          (players[0] as PPlayer)
        ).seat;
  const pick = players[rng(players.length)] as PPlayer;
  const next: PokerGame = {
    handId: g.handId + 1,
    phase: "preflop",
    deck: [...cards],
    board: [],
    players,
    button,
    sb: null,
    bb: null,
    blinds,
    turn: null,
    currentBet: 0,
    minRaise: blinds[1],
    cap: capToShortestStack ? Math.min(...players.map((p) => p.stack)) : null,
    result: null,
    boardSkin:
      boardSkin === "draw"
        ? { skinId: pick.skinId, backId: pick.backId }
        : creator,
  };
  // heads-up: the button is the small blind
  next.sb =
    players.length === 2
      ? button
      : (seatAfter(next, button, () => true) as number);
  next.bb = seatAfter(next, next.sb, () => true) as number;
  // cards go out from the seat left of the button, the button last
  const order = [
    ...players.filter((p) => p.seat > button),
    ...players.filter((p) => p.seat <= button),
  ];
  for (let round = 0; round < 2; round++) {
    for (const p of order) p.cards.push(next.deck.shift() as string);
  }
  put(next, player(next, next.sb) as PPlayer, blinds[0]);
  put(next, player(next, next.bb) as PPlayer, blinds[1]);
  next.currentBet = Math.max(...players.map((p) => p.bet));
  return proceed(next, next.bb);
}

// After any change: end the hand, end the street, or hand the turn to the next player.
function proceed(g: PokerGame, last: number): PokerGame {
  const alive = g.players.filter((p) => p.status !== "folded");
  if (alive.length === 1) return awardUncontested(g, alive[0] as PPlayer);
  const able = g.players.filter(canAct);
  const done =
    able.length === 0 ||
    (able.length === 1 && (able[0] as PPlayer).bet >= g.currentBet) ||
    able.every((p) => p.acted && p.bet === g.currentBet);
  if (done) return endStreet(g);
  return { ...g, turn: seatAfter(g, last, canAct) };
}

const NEXT = { preflop: "flop", flop: "turn", turn: "river" } as const;

function endStreet(g: PokerGame): PokerGame {
  for (const p of g.players) {
    p.bet = 0;
    p.acted = false;
  }
  g.currentBet = 0;
  g.minRaise = g.blinds[1];
  for (;;) {
    if (g.phase === "river") return showdown(g);
    g.phase = NEXT[g.phase as keyof typeof NEXT];
    g.deck.shift(); // burn
    g.board.push(...g.deck.splice(0, g.phase === "flop" ? 3 : 1));
    // with at most one player able to bet, the board just runs out
    if (g.players.filter(canAct).length > 1) {
      return { ...g, turn: seatAfter(g, g.button as number, canAct) };
    }
  }
}

type Pot = { amount: number; eligible: number[] };

// Main and side pots. `collected` counts only chips already swept in from finished streets.
export function buildPots(players: PPlayer[], collected: boolean): Pot[] {
  const c = (p: PPlayer) => (collected ? p.committed - p.bet : p.committed);
  const live = players.filter((p) => p.status !== "folded");
  const levels = [...new Set(live.map(c))]
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  let prev = 0;
  return levels.map((level, i) => {
    const top = i === levels.length - 1; // chips folded players put above the top level stay in the top pot
    const amount = players.reduce(
      (sum, p) =>
        sum +
        (top
          ? Math.max(0, c(p) - prev)
          : Math.max(0, Math.min(c(p), level) - prev)),
      0,
    );
    prev = level;
    return {
      amount,
      eligible: live.filter((p) => c(p) >= level).map((p) => p.seat),
    };
  });
}

function awardUncontested(g: PokerGame, winner: PPlayer): PokerGame {
  const amount = g.players.reduce((sum, p) => sum + p.committed, 0);
  winner.stack += amount;
  for (const p of g.players) p.bet = 0;
  return {
    ...g,
    phase: "showdown",
    turn: null,
    currentBet: 0,
    result: { winners: [{ seat: winner.seat, amount }], revealed: [] },
  };
}

function showdown(g: PokerGame): PokerGame {
  const hands = new Map<number, ReturnType<typeof bestHand>>();
  for (const p of g.players) {
    if (p.status !== "folded")
      hands.set(p.seat, bestHand([...p.cards, ...g.board]));
  }
  const won = new Map<number, number>();
  // odd chips go to the winners closest to the left of the button
  const fromButton = (seat: number) =>
    (seat - (g.button as number) + 1000) % 1000 || 1000;
  for (const pot of buildPots(g.players, false)) {
    const best = pot.eligible.reduce((top, s) =>
      compare(
        (hands.get(s) as { score: number[] }).score,
        (hands.get(top) as { score: number[] }).score,
      ) > 0
        ? s
        : top,
    );
    const winners = pot.eligible
      .filter(
        (s) =>
          compare(
            (hands.get(s) as { score: number[] }).score,
            (hands.get(best) as { score: number[] }).score,
          ) === 0,
      )
      .sort((a, b) => fromButton(a) - fromButton(b));
    const share = Math.floor(pot.amount / winners.length);
    const extra = pot.amount - share * winners.length;
    for (const [i, s] of winners.entries()) {
      won.set(s, (won.get(s) ?? 0) + share + (i < extra ? 1 : 0));
    }
  }
  const winners: Winner[] = [...won.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seat, amount]) => {
      const e = hands.get(seat) as HandInfo;
      return { seat, amount, hand: { rank: e.rank, cards: e.cards } };
    });
  for (const [seat, amount] of won)
    (player(g, seat) as PPlayer).stack += amount;
  for (const p of g.players) p.bet = 0;
  return {
    ...g,
    phase: "showdown",
    turn: null,
    currentBet: 0,
    result: { winners, revealed: [...hands.keys()] },
  };
}

// "Raise to" range for a total bet this street, or null when the player cannot bet more.
function raiseRange(g: PokerGame, p: PPlayer) {
  const all = p.bet + p.stack;
  const max = g.cap === null ? all : Math.min(all, g.cap - p.committed + p.bet);
  if (max <= g.currentBet) return null;
  return { min: Math.min(g.currentBet + g.minRaise, max), max };
}

export function legalActions(g: PokerGame, seat: number): LegalAction[] {
  const p = player(g, seat);
  if (!p || g.turn !== seat || !canAct(p)) return [];
  const toCall = g.currentBet - p.bet;
  const actions: LegalAction[] = [{ type: "fold" }];
  if (toCall === 0) actions.push({ type: "check" });
  else if (p.stack > toCall) actions.push({ type: "call", amount: toCall });
  else actions.push({ type: "all-in", amount: p.stack });
  const range = raiseRange(g, p);
  if (range)
    actions.push({ type: g.currentBet === 0 ? "bet" : "raise", ...range });
  return actions;
}

export function act(
  g: PokerGame,
  seat: number,
  action: { type: string; amount?: number | undefined },
): Result {
  const p = player(g, seat);
  const betting = g.phase !== "waiting" && g.phase !== "showdown";
  if (!betting || !p || !canAct(p)) return { error: "ILLEGAL_ACTION" };
  if (g.turn !== seat) return { error: "NOT_YOUR_TURN" };
  const toCall = g.currentBet - p.bet;
  const range = raiseRange(g, p);
  let raiseTo: number | null = null;

  switch (action.type) {
    case "fold":
    case "check":
    case "call":
      if (action.type === "check" && toCall !== 0)
        return { error: "ILLEGAL_ACTION" };
      if (action.type === "call" && toCall === 0)
        return { error: "ILLEGAL_ACTION" };
      break;
    case "bet":
    case "raise": {
      const to = action.amount;
      if (!range || to === undefined || !Number.isInteger(to))
        return { error: "ILLEGAL_ACTION" };
      if (to > p.bet + p.stack) return { error: "INSUFFICIENT_FUNDS" };
      if (to > range.max || (to < range.min && to !== range.max))
        return { error: "ILLEGAL_ACTION" };
      raiseTo = to;
      break;
    }
    case "all-in":
      raiseTo = range && range.max > g.currentBet ? range.max : null; // otherwise it is an all-in call
      break;
    default:
      return { error: "ILLEGAL_ACTION" };
  }

  const next = structuredClone(g);
  const me = player(next, seat) as PPlayer;
  if (action.type === "fold") me.status = "folded";
  else if (raiseTo === null) put(next, me, toCall);
  else {
    const size = raiseTo - next.currentBet;
    put(next, me, raiseTo - me.bet);
    if (size >= next.minRaise) next.minRaise = size;
    next.currentBet = Math.max(next.currentBet, me.bet);
    // shortcut: a short all-in raise reopens the betting like a full one; upgrade when house rules matter
    for (const o of next.players) o.acted = false;
  }
  me.acted = true;
  return { game: proceed(next, seat) };
}

// What happens when a player runs out of time: check if free, otherwise fold.
export function timeout(g: PokerGame): Result {
  const p = g.turn === null ? undefined : player(g, g.turn);
  if (!p) return { error: "ILLEGAL_ACTION" };
  return act(g, p.seat, {
    type: g.currentBet - p.bet === 0 ? "check" : "fold",
  });
}

export const bestHandOf = (
  g: PokerGame,
  seat: number,
): HandInfo | undefined => {
  const p = player(g, seat);
  if (
    !p ||
    p.cards.length === 0 ||
    (p.status === "folded" && g.phase !== "showdown")
  )
    return undefined;
  const e = bestHand([...p.cards, ...g.board]);
  return { rank: e.rank, cards: e.cards };
};

// Chips are on the table until the hand ends; players dealt in cannot leave.
export const inRound = (g: PokerGame, seat: number) =>
  g.phase !== "waiting" && g.phase !== "showdown" && !!player(g, seat);

export const removeSeat = (g: PokerGame, seat: number): PokerGame => ({
  ...g,
  players: g.players.filter((p) => p.seat !== seat),
});
