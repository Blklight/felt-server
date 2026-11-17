// Pure blackjack engine: no I/O, no clock, no Math.random. The RNG comes in as a parameter.
import type { ErrorCode, LegalAction, Outcome } from "../protocol";

export type Rng = (n: number) => number; // uniform integer in [0, n)

export const MIN_BET = 10;
export const MAX_BET = 500;

export type HandState =
  | "idle" // not playing this round
  | "betting" // waiting for a bet
  | "bet"
  | "playing"
  | "stood"
  | "bust"
  | "blackjack";

export type Hand = {
  seat: number;
  stack: number; // chips behind, not counting `bet`
  bet: number;
  cards: string[];
  state: HandState;
  skinId: string;
  backId: string;
  outcome?: Outcome;
};

export type Game = {
  handId: number;
  phase: "waiting" | "betting" | "players" | "results";
  deck: string[]; // never leaves the server
  dealer: string[];
  hands: Hand[];
  turn: number | null;
  board: { skinId: string; backId: string } | null;
};

export type Seated = {
  seat: number;
  stack: number;
  skinId: string;
  backId: string;
};

type Result = { game: Game } | { error: ErrorCode };

export const newGame = (): Game => ({
  handId: 0,
  phase: "waiting",
  deck: [],
  dealer: [],
  hands: [],
  turn: null,
  board: null,
});

// Two decks, reshuffled every hand: 6 hands of at most 11 cards each cannot exhaust 104 cards.
const freshDeck = () =>
  [0, 1].flatMap(() =>
    [..."A23456789TJQK"].flatMap((r) => [..."shdc"].map((s) => r + s)),
  );

export function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// Best total not over 21 (an ace counts 11 when that fits).
export function total(cards: string[]): number {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    const r = c[0] as string;
    if (r === "A") {
      aces++;
      sum += 1;
    } else sum += "TJQK".includes(r) ? 10 : Number(r);
  }
  return aces > 0 && sum + 10 <= 21 ? sum + 10 : sum;
}

const isNatural = (cards: string[]) =>
  cards.length === 2 && total(cards) === 21;

const edit = (g: Game): Game => structuredClone(g);
const handOf = (g: Game, seat: number) => g.hands.find((h) => h.seat === seat);

// Opens a betting round for everyone seated. Players with less than MIN_BET sit out.
// Stays in "waiting" when nobody can bet.
export function startBetting(
  g: Game,
  seated: Seated[],
  rng: Rng,
  boardSkin: "creator" | "draw",
  creator: { skinId: string; backId: string },
): Game {
  const hands: Hand[] = [...seated]
    .sort((a, b) => a.seat - b.seat)
    .map((s) => ({
      ...s,
      bet: 0,
      cards: [],
      state: s.stack >= MIN_BET ? "betting" : "idle",
    }));
  if (!hands.some((h) => h.state === "betting")) {
    return {
      ...g,
      phase: "waiting",
      deck: [],
      dealer: [],
      hands: [],
      turn: null,
    };
  }
  const pick = hands[rng(hands.length)] as Hand;
  return {
    handId: g.handId + 1,
    phase: "betting",
    deck: [],
    dealer: [],
    hands,
    turn: null,
    board:
      boardSkin === "draw"
        ? { skinId: pick.skinId, backId: pick.backId }
        : creator,
  };
}

export function placeBet(g: Game, seat: number, amount: number): Result {
  const h = handOf(g, seat);
  if (g.phase !== "betting" || h?.state !== "betting") {
    return { error: "ILLEGAL_ACTION" };
  }
  if (!Number.isInteger(amount) || amount < MIN_BET || amount > MAX_BET) {
    return { error: "ILLEGAL_ACTION" };
  }
  if (amount > h.stack) return { error: "INSUFFICIENT_FUNDS" };
  const next = edit(g);
  const mine = handOf(next, seat) as Hand;
  mine.stack -= amount;
  mine.bet = amount;
  mine.state = "bet";
  return { game: next };
}

export const allBet = (g: Game) =>
  g.phase === "betting" && !g.hands.some((h) => h.state === "betting");

// Deals to everyone who bet; the rest sit the hand out. `cards` is the shuffled shoe
// (a parameter so tests can stack it). Deal order: players, dealer, players, dealer (hole card).
export function deal(
  g: Game,
  rng: Rng,
  cards = shuffle(freshDeck(), rng),
): Game {
  const next = edit(g);
  const players = next.hands.filter((h) => h.state === "bet");
  for (const h of next.hands) if (h.state === "betting") h.state = "idle";
  if (players.length === 0) return { ...next, phase: "waiting", hands: [] };
  const shoe = [...cards];
  const draw = () => shoe.shift() as string;
  for (let round = 0; round < 2; round++) {
    for (const h of players) h.cards.push(draw());
    next.dealer.push(draw());
  }
  next.deck = shoe;
  next.phase = "players";
  for (const h of players)
    h.state = isNatural(h.cards) ? "blackjack" : "playing";
  return isNatural(next.dealer) ? finish(next) : advance(next);
}

// Next player still to act, or the dealer's turn when nobody is left.
function advance(g: Game): Game {
  const next = g.hands.find((h) => h.state === "playing");
  if (next) return { ...g, turn: next.seat };
  return finish({ ...g, turn: null });
}

function finish(g: Game): Game {
  const dealerNatural = isNatural(g.dealer);
  if (g.hands.some((h) => h.state === "stood")) {
    while (total(g.dealer) < 17) g.dealer.push(g.deck.shift() as string);
  }
  const dealer = total(g.dealer);
  for (const h of g.hands) {
    if (h.bet === 0) continue;
    const mine = total(h.cards);
    let outcome: Outcome;
    if (h.state === "bust") outcome = { kind: "bust", amount: -h.bet };
    else if (h.state === "blackjack") {
      outcome = dealerNatural
        ? { kind: "push", amount: 0 }
        : { kind: "blackjack", amount: Math.floor((h.bet * 3) / 2) };
    } else if (dealerNatural || (dealer <= 21 && mine < dealer)) {
      outcome = { kind: "lose", amount: -h.bet };
    } else if (dealer <= 21 && mine === dealer) {
      outcome = { kind: "push", amount: 0 };
    } else outcome = { kind: "win", amount: h.bet };
    h.stack += h.bet + outcome.amount;
    h.outcome = outcome;
  }
  return { ...g, phase: "results", turn: null };
}

export function act(
  g: Game,
  seat: number,
  type: "hit" | "stand" | "double",
): Result {
  const h = handOf(g, seat);
  if (g.phase !== "players" || h?.state !== "playing") {
    return { error: "ILLEGAL_ACTION" };
  }
  if (g.turn !== seat) return { error: "NOT_YOUR_TURN" };
  if (type === "double") {
    if (h.cards.length !== 2) return { error: "ILLEGAL_ACTION" };
    if (h.stack < h.bet) return { error: "INSUFFICIENT_FUNDS" };
  }
  const next = edit(g);
  const mine = handOf(next, seat) as Hand;
  if (type === "double") {
    mine.stack -= mine.bet;
    mine.bet *= 2;
  }
  if (type !== "stand") mine.cards.push(next.deck.shift() as string);
  const t = total(mine.cards);
  if (t > 21) mine.state = "bust";
  else if (type !== "hit" || t === 21) mine.state = "stood";
  return { game: mine.state === "playing" ? next : advance(next) };
}

export function legalActions(
  g: Game,
  seat: number,
  stack: number,
): LegalAction[] {
  const h = handOf(g, seat);
  if (g.phase === "waiting") {
    return stack >= MIN_BET
      ? [{ type: "bet", min: MIN_BET, max: Math.min(MAX_BET, stack) }]
      : [];
  }
  if (!h) return [];
  if (g.phase === "betting" && h.state === "betting") {
    return [{ type: "bet", min: MIN_BET, max: Math.min(MAX_BET, h.stack) }];
  }
  if (g.phase !== "players" || g.turn !== seat) return [];
  const actions: LegalAction[] = [{ type: "hit" }, { type: "stand" }];
  if (h.cards.length === 2 && h.stack >= h.bet) {
    actions.push({ type: "double", amount: h.bet });
  }
  return actions;
}

// Chips are on the table (a bet is out) until the round settles; those players cannot leave.
export const inRound = (g: Game, seat: number) => {
  const h = handOf(g, seat);
  return !!h && h.bet > 0 && (g.phase === "betting" || g.phase === "players");
};

export const removeSeat = (g: Game, seat: number): Game => ({
  ...g,
  hands: g.hands.filter((h) => h.seat !== seat),
});
