import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

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
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    game TEXT NOT NULL,
    room TEXT NOT NULL,
    delta INTEGER NOT NULL
  );
`;

// One per player, named by the SHA-256 of the account token. M0: schema only.
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
}
