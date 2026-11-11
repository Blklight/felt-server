import { describe, expect, it } from "vitest";
import { ClientMessage, isRoomCode } from "../src/protocol";

describe("room codes", () => {
  it.each(["KQ7XZ", "ABCDE", "23456"])("accepts %s", (code) => {
    expect(isRoomCode(code)).toBe(true);
  });

  it.each(["AB0O1", "abcde", "ABCD", "ABCDEF", ""])("rejects %j", (code) => {
    expect(isRoomCode(code)).toBe(false);
  });
});

describe("ClientMessage", () => {
  it("accepts the messages in the protocol", () => {
    for (const message of [
      { t: "hello", v: 1, token: "x".repeat(43) },
      { t: "sit", seat: 2, buyIn: 2000 },
      { t: "stand" },
      { t: "action", action: { type: "raise", amount: 300 } },
      { t: "emote", id: "gg" },
      { t: "ping" },
    ]) {
      expect(ClientMessage.safeParse(message).success).toBe(true);
    }
  });

  it.each([
    { t: "hello", v: 2, token: "x" },
    { t: "sit", seat: -1, buyIn: 100 },
    { t: "sit", seat: 1, buyIn: 0 },
    { t: "action", action: { type: "steal" } },
    { t: "unknown" },
  ])("rejects %j", (message) => {
    expect(ClientMessage.safeParse(message).success).toBe(false);
  });
});
