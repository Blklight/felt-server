import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Account } from "../src/durable/Account";

const BASE = "https://felt.test";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 11, 12);

const call = (path: string, init: RequestInit = {}, token?: string) =>
  exports.default.fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

async function signUp(body: unknown = { name: "Jogador" }) {
  const res = await call("/v1/accounts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    data: { playerId: string; token: string; profile: Record<string, unknown> };
  };
  return { res, ...json.data };
}

async function stubFor(token: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const hash = [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(hash));
}

describe("POST /v1/accounts", () => {
  it("creates an account with defaults and a 43-char token", async () => {
    const { res, token, playerId, profile } = await signUp();
    expect(res.status).toBe(201);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(profile).toEqual({
      playerId,
      name: "Jogador",
      avatarId: "a1",
      skinId: "classic",
      backId: "ink",
      balance: 5000,
      refills: 0,
    });
  });

  it("stores only the hash, never the token", async () => {
    const { token } = await signUp({ name: "Ana", avatarId: "a3" });
    const stub = await stubFor(token);
    await runInDurableObject(stub, (_i: Account, state) => {
      const row = state.storage.sql
        .exec<{ token_hash: string }>("SELECT token_hash FROM account")
        .one();
      expect(row.token_hash).toHaveLength(64);
      expect(row.token_hash).not.toBe(token);
    });
  });

  it.each([
    [{ name: "A" }, "too_short"],
    [{ name: "x".repeat(21) }, "too_long"],
    [{ name: " a " }, "too_short"],
  ])("rejects bad name %j", async (body, code) => {
    const res = await call("/v1/accounts", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", fields: { name: code } },
    });
  });

  it("requires a name", async () => {
    const res = await call("/v1/accounts", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", fields: { name: "invalid" } },
    });
  });

  it("rejects an unknown avatar", async () => {
    const res = await call("/v1/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "Ana", avatarId: "zz" }),
    });
    expect(await res.json()).toMatchObject({
      error: { fields: { avatarId: "invalid" } },
    });
  });
});

describe("auth", () => {
  it.each([
    [undefined],
    ["short"],
    ["A".repeat(43)], // well formed but unknown
  ])("returns 401 for token %s", async (token) => {
    const res = await call("/v1/me", {}, token);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

describe("GET/PATCH /v1/me", () => {
  it("returns the profile", async () => {
    const { token, profile } = await signUp({ name: "Bia" });
    const res = await call("/v1/me", {}, token);
    expect(((await res.json()) as { data: unknown }).data).toEqual(profile);
  });

  it("patches fields and validates them", async () => {
    const { token } = await signUp();
    const ok = await call(
      "/v1/me",
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Caio", skinId: "noir", backId: "neon" }),
      },
      token,
    );
    expect(((await ok.json()) as { data: unknown }).data).toMatchObject({
      name: "Caio",
      skinId: "noir",
      backId: "neon",
      avatarId: "a1",
    });
    const bad = await call(
      "/v1/me",
      { method: "PATCH", body: JSON.stringify({ skinId: "gold" }) },
      token,
    );
    expect(bad.status).toBe(400);
  });
});

describe("daily refill", () => {
  const setBalance = async (token: string, balance: number) => {
    const stub = await stubFor(token);
    await runInDurableObject(stub, (_i: Account, state) => {
      state.storage.sql.exec("UPDATE account SET balance = ?", balance);
    });
    return stub;
  };

  it("tops up a low balance by at most 2500, once per UTC day", async () => {
    const { token } = await signUp();
    const stub = await setBalance(token, 1000);
    expect((await stub.me(T0))?.balance).toBe(3500);
    expect((await stub.me(T0 + 1000))?.balance).toBe(3500);
    expect((await stub.me(T0 + DAY))?.balance).toBe(5000); // capped
    expect((await stub.me(T0 + DAY))?.refills).toBe(2);
  });

  it("gives nothing at or above 5000", async () => {
    const { token } = await signUp();
    const stub = await setBalance(token, 7000);
    const profile = await stub.me(T0);
    expect(profile).toMatchObject({ balance: 7000, refills: 0 });
  });

  it("records the refill in the ledger with a day ref", async () => {
    const { token } = await signUp();
    const stub = await setBalance(token, 100);
    await stub.me(T0);
    await runInDurableObject(stub, (_i: Account, state) => {
      const row = state.storage.sql
        .exec<{ delta: number; reason: string; ref: string }>(
          "SELECT delta, reason, ref FROM ledger WHERE reason = 'refill'",
        )
        .one();
      expect(row).toEqual({
        delta: 2500,
        reason: "refill",
        ref: "refill:2026-11-11",
      });
    });
  });
});

describe("DELETE /v1/me", () => {
  it("erases the account; the token then yields 401", async () => {
    const { token } = await signUp();
    const stub = await stubFor(token);
    const res = await call("/v1/me", { method: "DELETE" }, token);
    expect(await res.json()).toEqual({ data: null, error: null, message: "" });
    expect((await call("/v1/me", {}, token)).status).toBe(401);
    await runInDurableObject(stub, (_i: Account, state) => {
      for (const t of ["account", "ledger", "history"]) {
        const n = state.storage.sql
          .exec<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)
          .one().n;
        expect(n).toBe(0);
      }
    });
  });
});
