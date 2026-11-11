import type { Rng } from "./engine/blackjack";

// Production RNG for the engine: unbiased integer in [0, n) from crypto.getRandomValues.
export const cryptoRng: Rng = (n) => {
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while ((buf[0] as number) >= limit);
  return (buf[0] as number) % n;
};
