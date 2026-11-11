import { z } from "zod";

// Source of truth for the wire format. felt-web keeps a synced copy (docs/api-guide.md).
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 4096;

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
  "FORBIDDEN_ORIGIN",
  "NOT_FOUND",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ServerMessage =
  | { t: "pong" }
  | { t: "echo"; message: ClientMessage }
  | { t: "error"; code: ErrorCode; message?: string };

// Exact strings for setWebSocketAutoResponse: answered without waking the Durable Object.
export const PING = JSON.stringify({ t: "ping" });
export const PONG = JSON.stringify({ t: "pong" });
