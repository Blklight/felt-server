import { describe, expect, it } from "vitest";
import { bestHand, compare } from "../src/engine/handEval";

const h = (s: string) => s.split(" ");

describe("bestHand", () => {
  it.each([
    ["As Ks Qs Js Ts 2d 3c", "royal-flush"],
    ["9h 8h 7h 6h 5h Ad Ac", "straight-flush"],
    ["As Ad Ah Ac 2d 3c 4h", "four-of-a-kind"],
    ["Ks Kd Kh 2c 2d 7c 9h", "full-house"],
    ["As Ks 9s 5s 2s Qd Qc", "flush"],
    ["5s 6d 7h 8c 9s Kd Kc", "straight"],
    ["As 2d 3h 4c 5s Kd 9c", "straight"], // wheel
    ["Qs Qd Qh 2c 5d 7c 9h", "three-of-a-kind"],
    ["Qs Qd 5h 5c 2d 7c 9h", "two-pair"],
    ["Qs Qd 3h 5c 2d 7c 9h", "pair"],
    ["As Qd 3h 5c 2d 7c 9h", "high-card"],
  ])("%s -> %s", (cards, rank) => {
    expect(bestHand(h(cards)).rank).toBe(rank);
  });

  it("returns the five cards that make the hand", () => {
    const e = bestHand(h("As Ad 7h 7c 2d Kc 9h"));
    expect(e.rank).toBe("two-pair");
    expect(e.cards).toHaveLength(5);
    expect(e.cards.slice(0, 4).sort()).toEqual(["7c", "7h", "Ad", "As"].sort());
    expect(e.cards[4]).toBe("Kc");
  });

  it("wheel plays the ace low", () => {
    expect(bestHand(h("As 2d 3h 4c 5s")).cards[4]).toBe("As");
    expect(
      compare(
        bestHand(h("As 2d 3h 4c 5s")).score,
        bestHand(h("2d 3h 4c 5s 6s")).score,
      ),
    ).toBeLessThan(0);
  });

  it("compares kickers and categories", () => {
    const better = bestHand(h("Ks Kd 9h 5c 2d 7c 3h"));
    const worse = bestHand(h("Ks Kd 8h 5c 2d 7c 3h"));
    expect(compare(better.score, worse.score)).toBeGreaterThan(0);
    expect(
      compare(
        bestHand(h("2s 2d 2h 5c 9d")).score,
        bestHand(h("As Kd Qh Jc 9d")).score,
      ),
    ).toBeGreaterThan(0);
    expect(
      compare(
        bestHand(h("As Ad 7h 7c 2d")).score,
        bestHand(h("As Ad 7h 7c 2d")).score,
      ),
    ).toBe(0);
  });

  it("two hole cards only: pair or high card", () => {
    expect(bestHand(h("As Ad")).rank).toBe("pair");
    expect(bestHand(h("As Kd")).rank).toBe("high-card");
  });
});
