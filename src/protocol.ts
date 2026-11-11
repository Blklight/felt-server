import { z } from "zod";

// Source of truth for the wire format. felt-web keeps a synced copy (docs/api-guide.md).
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 4096;

export const AVATAR_IDS = [
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "a8",
] as const;
export const CARD_SKINS = ["classic", "fantasy", "noir", "vice"] as const;
export const CARD_BACKS = ["ink", "neon", "vice", "suits"] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];
export type CardSkin = (typeof CARD_SKINS)[number];
export type CardBackVariant = (typeof CARD_BACKS)[number];

export const STARTING_CREDITS = 5000;
export const DAILY_REFILL = 2500;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const name = z.string().trim().min(2).max(20);
export const CreateAccountBody = z.object({
  name: name.optional(),
  avatarId: z.enum(AVATAR_IDS).optional(),
});
export const PatchMeBody = z.object({
  name: name.optional(),
  avatarId: z.enum(AVATAR_IDS).optional(),
  skinId: z.enum(CARD_SKINS).optional(),
  backId: z.enum(CARD_BACKS).optional(),
});

const boardSkin = z.enum(["creator", "draw"]).default("creator");
export const RoomConfig = z.discriminatedUnion("game", [
  z.object({
    game: z.literal("poker"),
    blinds: z
      .union([
        z.tuple([z.literal(10), z.literal(20)]),
        z.tuple([z.literal(25), z.literal(50)]),
        z.tuple([z.literal(50), z.literal(100)]),
      ])
      .default([25, 50]),
    capToShortestStack: z.boolean().default(false),
    boardSkin,
  }),
  z.object({ game: z.literal("blackjack"), boardSkin }),
]);
export type RoomConfig = z.infer<typeof RoomConfig>;
export const CreateRoomBody = z.object({
  game: z.enum(["poker", "blackjack"]),
  config: z.record(z.string(), z.unknown()).optional(),
});

// Seats per game. Guide does not fix these; poker max is bounded by the protocol's seat index (0-9).
export const SEATS = { poker: 9, blackjack: 5 } as const;

export type Profile = {
  playerId: string;
  name: string;
  avatarId: AvatarId;
  skinId: CardSkin;
  backId: CardBackVariant;
  balance: number;
  refills: number;
};

export const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE = /^[A-HJ-NP-Z2-9]{5}$/;
export const isRoomCode = (code: string) => ROOM_CODE.test(code);

const ActionType = z.enum([
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "all-in",
  "hit",
  "stand",
  "double",
]);

export const ClientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.literal(PROTOCOL_VERSION),
    token: z.string().min(1).max(128),
  }),
  z.object({
    t: z.literal("sit"),
    seat: z.number().int().min(0).max(9),
    buyIn: z.number().int().positive(),
  }),
  z.object({ t: z.literal("stand") }),
  z.object({
    t: z.literal("action"),
    action: z.object({
      type: ActionType,
      amount: z.number().int().positive().optional(),
    }),
  }),
  z.object({ t: z.literal("emote"), id: z.string().min(1).max(32) }),
  z.object({ t: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ERROR_CODES = [
  "NOT_YOUR_TURN",
  "ILLEGAL_ACTION",
  "INSUFFICIENT_FUNDS",
  "SEAT_TAKEN",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "VALIDATION_ERROR",
  "FORBIDDEN_ORIGIN",
  "NOT_FOUND",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type CardCode = string; // "As", "Td"; "??" = hidden
export type LegalAction = {
  type: z.infer<typeof ActionType>;
  min?: number;
  max?: number;
  amount?: number;
};
export type HandRank =
  | "royal-flush"
  | "straight-flush"
  | "four-of-a-kind"
  | "full-house"
  | "flush"
  | "straight"
  | "three-of-a-kind"
  | "two-pair"
  | "pair"
  | "high-card";
export type HandInfo = { rank: HandRank; cards: CardCode[] };
export type Winner = { seat: number; amount: number; hand?: HandInfo };

export type Outcome = {
  kind: "win" | "blackjack" | "push" | "lose" | "bust";
  amount: number; // net profit; negative when the bet is lost
};
export type SeatView = {
  seat: number;
  name: string;
  avatarId: AvatarId;
  skinId: CardSkin;
  backId: CardBackVariant;
  stack: number;
  bet: number;
  cards: CardCode[];
  status: "active" | "folded" | "all-in" | "out" | "empty";
  isDealer: boolean;
  blind?: "small" | "big";
  total?: number;
  outcome?: Outcome;
  isTurn: boolean;
};
export type TableView = {
  handId: number;
  game: RoomConfig["game"];
  phase:
    | "waiting"
    | "preflop"
    | "flop"
    | "turn"
    | "river"
    | "showdown"
    | "betting"
    | "dealing"
    | "players"
    | "dealer"
    | "results";
  seats: SeatView[];
  board: CardCode[];
  boardSkinId: CardSkin;
  boardBackId: CardBackVariant;
  pots: number[];
  secondsLeft: number | null;
  you: { seat: number | null; legalActions: LegalAction[]; hand?: HandInfo };
  result?: { winners: Winner[] };
  buyIn?: { min: number; max: number };
  dealerTotal?: number;
};

export type ServerMessage =
  | { t: "pong" }
  | { t: "echo"; message: ClientMessage }
  | {
      t: "welcome";
      seq: number;
      you: { playerId: string; name: string };
      view: TableView;
    }
  | { t: "view"; seq: number; view: TableView }
  | { t: "error"; code: ErrorCode; message?: string };

// Exact strings for setWebSocketAutoResponse: answered without waking the Durable Object.
export const PING = JSON.stringify({ t: "ping" });
export const PONG = JSON.stringify({ t: "pong" });
