// Pure poker hand evaluation. Works on 1-7 cards; with fewer than 5 only pair/high card are possible.
import type { HandInfo, HandRank } from "../protocol";

const VALUE = (c: string) => "23456789TJQKA".indexOf(c[0] as string) + 2;

const CATEGORY: HandRank[] = [
  "high-card",
  "pair",
  "two-pair",
  "three-of-a-kind",
  "straight",
  "flush",
  "full-house",
  "four-of-a-kind",
  "straight-flush",
  "royal-flush",
];

export type Evaluated = HandInfo & { score: number[] };

function eval5(cards: string[]): Evaluated {
  const groups = new Map<number, string[]>();
  for (const c of cards)
    groups.set(VALUE(c), [...(groups.get(VALUE(c)) ?? []), c]);
  // groups by size, then by value: the order that decides ties
  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || b[0] - a[0],
  );
  const counts = ordered.map(([, g]) => g.length);
  const values = ordered.map(([v]) => v);
  const flush =
    cards.length === 5 && cards.every((c) => c[1] === cards[0]?.[1]);
  const wheel = values.join() === "14,5,4,3,2";
  const straight =
    cards.length === 5 &&
    values.length === 5 &&
    ((values[0] as number) - (values[4] as number) === 4 || wheel);

  let cat = 0;
  if (straight && flush) cat = values[0] === 14 && !wheel ? 9 : 8;
  else if (counts[0] === 4) cat = 7;
  else if (counts[0] === 3 && counts[1] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (straight) cat = 4;
  else if (counts[0] === 3) cat = 3;
  else if (counts[0] === 2 && counts[1] === 2) cat = 2;
  else if (counts[0] === 2) cat = 1;

  let tiebreak = values;
  let sorted = ordered.flatMap(([, g]) => g);
  if (wheel) {
    tiebreak = [5];
    sorted = [...sorted.slice(1), sorted[0] as string]; // ace plays low: 5 4 3 2 A
  }
  return {
    rank: CATEGORY[cat] as HandRank,
    cards: sorted,
    score: [cat, ...tiebreak],
  };
}

export const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

function combos<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items as [T, ...T[]];
  return [...combos(rest, k - 1).map((c) => [head, ...c]), ...combos(rest, k)];
}

// Best hand using at most 5 of the given cards.
export function bestHand(cards: string[]): Evaluated {
  let best: Evaluated | null = null;
  for (const combo of combos(cards, Math.min(5, cards.length))) {
    const e = eval5(combo);
    if (!best || compare(e.score, best.score) > 0) best = e;
  }
  return best as Evaluated;
}
