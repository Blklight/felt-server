import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import type { Env } from "../env";
import {
  type AvatarId,
  type CardBackVariant,
  type CardSkin,
  DAILY_REFILL,
  type PatchMeBody,
  type Profile,
  STARTING_CREDITS,
} from "../protocol";

// Daily refill only tops the balance up to the starting amount.
const MAX_REFILL_BALANCE = STARTING_CREDITS;

// Schema from felt-plano.md 3.4 plus the decisions in docs/api-guide.md (skin, back, daily refill).
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_id TEXT NOT NULL,
    skin_id TEXT NOT NULL,
    back_id TEXT NOT NULL,
    balance INTEGER NOT NULL,
    refills INTEGER NOT NULL DEFAULT 0,
    last_refill_day TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT NOT NULL UNIQUE
  );
  -- one row per open table seat (buyin ref); a seated player cannot rename
  CREATE TABLE IF NOT EXISTS session (ref TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    game TEXT NOT NULL,
    room TEXT NOT NULL,
    delta INTEGER NOT NULL
  );
`;

type Row = {
  id: string;
  name: string;
  avatar_id: AvatarId;
  skin_id: CardSkin;
  back_id: CardBackVariant;
  balance: number;
  refills: number;
  last_refill_day: string | null;
};

export type NewAccount = {
  playerId: string;
  tokenHash: string;
  name: string;
  avatarId: AvatarId;
};

// One per player, named by the SHA-256 of the account token.
export class Account extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA);
    });
  }

  exists(): boolean {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM account")
      .one();
    return row.n > 0;
  }

  create(input: NewAccount, now: number): Profile {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO account (id, token_hash, name, avatar_id, skin_id, back_id, balance, created_at, last_seen)
         VALUES (?, ?, ?, ?, 'classic', 'ink', ?, ?, ?)`,
        input.playerId,
        input.tokenHash,
        input.name,
        input.avatarId,
        STARTING_CREDITS,
        now,
        now,
      );
      sql.exec(
        "INSERT INTO ledger (ts, delta, reason, ref) VALUES (?, ?, 'start', 'start')",
        now,
        STARTING_CREDITS,
      );
    });
    return this.profile() as Profile;
  }

  // Returns null when the account does not exist. Applies the daily refill (idempotent by ledger ref).
  me(now: number): Profile | null {
    if (!this.exists()) return null;
    const sql = this.ctx.storage.sql;
    const day = new Date(now).toISOString().slice(0, 10);
    this.ctx.storage.transactionSync(() => {
      const row = this.row();
      if (row.last_refill_day !== day) {
        const gain = Math.min(DAILY_REFILL, MAX_REFILL_BALANCE - row.balance);
        if (gain > 0) {
          sql.exec(
            "INSERT INTO ledger (ts, delta, reason, ref) VALUES (?, ?, 'refill', ?)",
            now,
            gain,
            `refill:${day}`,
          );
          sql.exec(
            "UPDATE account SET balance = balance + ?, refills = refills + 1 WHERE id = ?",
            gain,
            row.id,
          );
        }
        sql.exec("UPDATE account SET last_refill_day = ?", day);
      }
      sql.exec("UPDATE account SET last_seen = ?", now);
    });
    return this.profile();
  }

  // Moves chips between the balance and a table. Idempotent: a `ref` already in the ledger changes nothing.
  settle(
    delta: number,
    reason: "buyin" | "cashout",
    ref: string,
    now: number,
  ): { profile: Profile } | { error: "INSUFFICIENT_FUNDS" | "NO_ACCOUNT" } {
    if (!this.exists()) return { error: "NO_ACCOUNT" };
    const sql = this.ctx.storage.sql;
    const applied =
      sql.exec("SELECT 1 FROM ledger WHERE ref = ?", ref).toArray().length > 0;
    if (!applied) {
      if (this.row().balance + delta < 0)
        return { error: "INSUFFICIENT_FUNDS" };
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "INSERT INTO ledger (ts, delta, reason, ref) VALUES (?, ?, ?, ?)",
          now,
          delta,
          reason,
          ref,
        );
        sql.exec("UPDATE account SET balance = balance + ?", delta);
        if (reason === "buyin") {
          sql.exec("INSERT OR IGNORE INTO session (ref) VALUES (?)", ref);
        } else {
          sql.exec(
            "DELETE FROM session WHERE ref = ?",
            `buyin:${ref.slice("cashout:".length)}`,
          );
        }
      });
    }
    return { profile: this.profile() as Profile };
  }

  // While seated at any table the profile is frozen: returns the names of the fields that would change.
  update(
    patch: z.infer<typeof PatchMeBody>,
  ): Profile | { locked: string[] } | null {
    if (!this.exists()) return null;
    const current = this.profile() as Profile;
    const seated =
      this.ctx.storage.sql.exec("SELECT 1 FROM session").toArray().length > 0;
    const locked = (Object.keys(patch) as (keyof typeof patch)[]).filter(
      (k) => patch[k] !== undefined && patch[k] !== current[k],
    );
    if (seated && locked.length > 0) return { locked };
    const columns = {
      name: patch.name,
      avatar_id: patch.avatarId,
      skin_id: patch.skinId,
      back_id: patch.backId,
    };
    for (const [column, value] of Object.entries(columns)) {
      if (value !== undefined) {
        // column comes from the fixed object above, never from input
        this.ctx.storage.sql.exec(`UPDATE account SET ${column} = ?`, value);
      }
    }
    return this.profile();
  }

  destroy(): void {
    this.ctx.storage.transactionSync(() => {
      for (const table of ["account", "ledger", "history", "session"]) {
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      }
    });
  }

  private row(): Row {
    return this.ctx.storage.sql.exec<Row>("SELECT * FROM account").one();
  }

  private profile(): Profile | null {
    if (!this.exists()) return null;
    const r = this.row();
    return {
      playerId: r.id,
      name: r.name,
      avatarId: r.avatar_id,
      skinId: r.skin_id,
      backId: r.back_id,
      balance: r.balance,
      refills: r.refills,
    };
  }
}
