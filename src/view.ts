import { type Game, legalActions, total } from "./engine/blackjack";
import {
  bestHandOf,
  buildPots,
  type PokerGame,
  legalActions as pokerLegalActions,
} from "./engine/poker";
import {
  type AvatarId,
  type CardBackVariant,
  type CardSkin,
  type RoomConfig,
  SEATS,
  type SeatView,
  type TableView,
} from "./protocol";

export type Creator = { skinId: CardSkin; backId: CardBackVariant };

export type SeatInfo = {
  seat: number;
  playerId: string;
  name: string;
  avatarId: AvatarId;
  skinId: CardSkin;
  backId: CardBackVariant;
  stack: number;
};

const emptySeat = (seat: number): SeatView => ({
  seat,
  name: "",
  avatarId: "a1",
  skinId: "classic",
  backId: "ink",
  stack: 0,
  bet: 0,
  cards: [],
  status: "empty",
  isDealer: false,
  isTurn: false,
});

// Buy-in limits (docs/api-guide.md, section 2.2): poker 20-100 BB, blackjack 200-2000.
export const buyInRange = (config: RoomConfig) =>
  config.game === "poker"
    ? { min: config.blinds[1] * 20, max: config.blinds[1] * 100 }
    : { min: 200, max: 2000 };

// Blackjack state as one viewer sees it. `secondsLeft` is relative to the moment of sending;
// `secondsTotal` is the full length of the running timer.
export type Round = {
  game: Game;
  secondsLeft: number | null;
  secondsTotal: number | null;
  leaving: number[];
};

// The view one player gets (`viewer` null = spectator). This is the only place that decides who sees what.
// Player cards are dealt face up (as at a real table); the deck never appears and the dealer's hole
// card is "??" until the round settles.
function blackjackView(
  config: RoomConfig,
  creator: Creator,
  taken: SeatInfo[],
  viewer: string | null,
  round: Round | null,
): TableView {
  const mine = taken.find((s) => s.playerId === viewer);
  const game = round?.game;
  const seats = Array.from({ length: SEATS[config.game] }, (_, i) => {
    const s = taken.find((t) => t.seat === i);
    if (!s) return emptySeat(i);
    const { playerId: _playerId, ...rest } = s;
    const hand = game?.hands.find((h) => h.seat === i);
    const cards = hand?.cards ?? [];
    const sitting = hand?.state === "idle" && game?.phase !== "betting";
    return {
      ...emptySeat(i),
      ...rest,
      status:
        sitting && game?.phase !== "waiting"
          ? ("out" as const)
          : ("active" as const),
      bet: hand?.bet ?? 0,
      cards: [...cards],
      ...(cards.length > 0 ? { total: total(cards) } : {}),
      ...(game?.phase === "results" && hand?.outcome
        ? { outcome: hand.outcome }
        : {}),
      isTurn: game?.turn === i,
      ...(round?.leaving.includes(i) ? { leaving: true as const } : {}),
    };
  });
  const hidden = game?.phase === "players" && game.dealer.length >= 2;
  const board = game
    ? hidden
      ? [game.dealer[0] as string, "??"]
      : [...game.dealer]
    : [];
  const visible = board.filter((c) => c !== "??");
  return {
    handId: game?.handId ?? 0,
    game: config.game,
    phase: game?.phase ?? "waiting",
    seats,
    board,
    boardSkinId: (game?.board?.skinId ?? creator.skinId) as Creator["skinId"],
    boardBackId: (game?.board?.backId ?? creator.backId) as Creator["backId"],
    pots: [],
    secondsLeft: round?.secondsLeft ?? null,
    ...(round?.secondsTotal != null
      ? { secondsTotal: round.secondsTotal }
      : {}),
    you: {
      seat: mine?.seat ?? null,
      legalActions:
        game && mine ? legalActions(game, mine.seat, mine.stack) : [],
    },
    ...(mine ? {} : { buyIn: buyInRange(config) }),
    ...(visible.length > 0 ? { dealerTotal: total(visible) } : {}),
  };
}

// Texas Hold'em as one viewer sees it. A hole card is real only for its owner, and for the
// players who reached a contested showdown; everyone else sees "??". The deck and burns never appear.
function pokerView(
  config: RoomConfig,
  creator: Creator,
  taken: SeatInfo[],
  viewer: string | null,
  g: PokerGame,
  timer: Pick<Round, "secondsLeft" | "secondsTotal" | "leaving">,
): TableView {
  const { secondsLeft, secondsTotal, leaving } = timer;
  const mine = taken.find((s) => s.playerId === viewer);
  const idle = g.phase === "waiting" || g.phase === "showdown";
  const seats = Array.from({ length: SEATS.poker }, (_, i) => {
    const s = taken.find((t) => t.seat === i);
    if (!s) return emptySeat(i);
    const { playerId, ...rest } = s;
    const p = g.players.find((q) => q.seat === i);
    const own = playerId === viewer;
    const shown = own || g.result?.revealed.includes(i);
    const cards = !p
      ? []
      : p.status === "folded"
        ? own
          ? [...p.cards]
          : []
        : shown
          ? [...p.cards]
          : p.cards.map(() => "??");
    return {
      ...emptySeat(i),
      ...rest,
      stack: p?.stack ?? s.stack,
      bet: p?.bet ?? 0,
      cards,
      status: p ? p.status : idle ? ("active" as const) : ("out" as const),
      isDealer: g.phase !== "waiting" && g.button === i,
      ...(g.phase !== "waiting" && g.sb === i
        ? { blind: "small" as const }
        : {}),
      ...(g.phase !== "waiting" && g.bb === i ? { blind: "big" as const } : {}),
      isTurn: g.turn === i,
      ...(leaving.includes(i) ? { leaving: true as const } : {}),
    };
  });
  const hand = mine ? bestHandOf(g, mine.seat) : undefined;
  return {
    handId: g.handId,
    game: "poker",
    phase: g.phase,
    seats,
    board: [...g.board],
    boardSkinId: (g.boardSkin?.skinId ?? creator.skinId) as Creator["skinId"],
    boardBackId: (g.boardSkin?.backId ?? creator.backId) as Creator["backId"],
    pots:
      g.phase === "showdown"
        ? []
        : buildPots(g.players, true).map((pot) => pot.amount),
    secondsLeft,
    ...(secondsTotal !== null ? { secondsTotal } : {}),
    you: {
      seat: mine?.seat ?? null,
      legalActions: mine ? pokerLegalActions(g, mine.seat) : [],
      ...(hand ? { hand } : {}),
    },
    ...(g.phase === "showdown" && g.result
      ? { result: { winners: g.result.winners } }
      : {}),
    ...(mine ? {} : { buyIn: buyInRange(config) }),
  };
}

export type RoomState = {
  blackjack: Game;
  poker: PokerGame;
} & Pick<Round, "secondsLeft" | "secondsTotal" | "leaving">;

export function tableView(
  config: RoomConfig,
  creator: Creator,
  taken: SeatInfo[],
  viewer: string | null,
  state: RoomState,
): TableView {
  return config.game === "poker"
    ? pokerView(config, creator, taken, viewer, state.poker, state)
    : blackjackView(config, creator, taken, viewer, {
        ...state,
        game: state.blackjack,
      });
}
