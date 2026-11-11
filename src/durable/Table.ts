import { DurableObject } from "cloudflare:workers";
import {
  act,
  allBet,
  deal,
  type Game,
  inRound,
  newGame,
  placeBet,
  removeSeat,
  startBetting,
} from "../engine/blackjack";
import {
  act as actPoker,
  inRound as inPokerRound,
  newPokerGame,
  type PokerGame,
  timeout as pokerTimeout,
  removeSeat as removePokerSeat,
  startHand,
} from "../engine/poker";
import type { Env } from "../env";
import {
  ClientMessage,
  type ErrorCode,
  MAX_MESSAGE_BYTES,
  PING,
  PONG,
  type RoomConfig,
  SEATS,
  type ServerMessage,
  TOKEN,
} from "../protocol";
import { cryptoRng } from "../rng";
import { sha256 } from "../token";
import { buyInRange, type Creator, type SeatInfo, tableView } from "../view";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config TEXT NOT NULL,
    creator_skin TEXT NOT NULL,
    creator_back TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seat (
    seat INTEGER PRIMARY KEY,
    player_id TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL,
    session TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_id TEXT NOT NULL,
    skin_id TEXT NOT NULL,
    back_id TEXT NOT NULL,
    stack INTEGER NOT NULL,
    buy_in INTEGER NOT NULL,
    pending INTEGER NOT NULL,
    deadline INTEGER
  );
  CREATE TABLE IF NOT EXISTS snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

// Codes a peer reports but that may not be sent back in a close frame (RFC 6455, 7.4.1).
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

const HELLO_TIMEOUT_MS = 5000;
const DISCONNECT_MS = 120_000; // a disconnected player keeps the seat this long
const MESSAGES_PER_SECOND = 20;
const BET_MS = 15_000;
const TURN_MS = 20_000;
const RESULTS_MS = 6000;
const POKER_TURN_MS = 30_000;
const SHOWDOWN_MS = 8000;
const PENDING_RETRY_MS = 5000; // a buy-in that never finished is retried (idempotent) after this

// The table state saved on every action (one upsert). `deadline` is the next game timer.
type Snapshot = { game: Game; poker: PokerGame; deadline: number | null };

type SeatRow = {
  seat: number;
  player_id: string;
  token_hash: string;
  session: string;
  name: string;
  avatar_id: SeatInfo["avatarId"];
  skin_id: SeatInfo["skinId"];
  back_id: SeatInfo["backId"];
  stack: number;
  buy_in: number;
  pending: number;
  deadline: number | null;
};

// Survives hibernation (serializeAttachment). `player` is set once `hello` is accepted.
type Attachment = {
  connectedAt: number;
  tokenHash?: string;
  player?: { playerId: string; name: string };
};

const send = (ws: WebSocket, message: ServerMessage) =>
  ws.send(JSON.stringify(message));

// One per room (idFromName(room code)). M0: accepts sockets with hibernation and echoes valid messages.
export class Table extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA);
    });
  }

  // False when the code is already taken (caller picks another code).
  create(config: RoomConfig, creator: Creator, now: number): boolean {
    if (this.info()) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO room (id, config, creator_skin, creator_back, created_at) VALUES (1, ?, ?, ?, ?)",
      JSON.stringify(config),
      creator.skinId,
      creator.backId,
      now,
    );
    return true;
  }

  private room() {
    const row = this.ctx.storage.sql
      .exec<{
        config: string;
        creator_skin: Creator["skinId"];
        creator_back: Creator["backId"];
        seq: number;
      }>("SELECT config, creator_skin, creator_back, seq FROM room")
      .toArray()[0];
    if (!row) return null;
    return {
      config: JSON.parse(row.config) as RoomConfig,
      creator: { skinId: row.creator_skin, backId: row.creator_back },
      seq: row.seq,
    };
  }

  info(): { game: RoomConfig["game"]; seats: number; taken: number } | null {
    const room = this.room();
    if (!room) return null;
    const { game } = room.config;
    return { game, seats: SEATS[game], taken: this.seatRows().length };
  }

  private seatRows(): SeatRow[] {
    return this.ctx.storage.sql.exec<SeatRow>("SELECT * FROM seat").toArray();
  }

  private account(tokenHash: string) {
    return this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(tokenHash));
  }

  private viewFor(room: NonNullable<ReturnType<Table["room"]>>, id: string) {
    const taken: SeatInfo[] = this.seatRows().map((r) => ({
      seat: r.seat,
      playerId: r.player_id,
      name: r.name,
      avatarId: r.avatar_id,
      skinId: r.skin_id,
      backId: r.back_id,
      stack: r.stack,
    }));
    const { game, poker, deadline } = this.snapshot();
    const secondsLeft =
      deadline === null
        ? null
        : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    return tableView(room.config, room.creator, taken, id, {
      blackjack: game,
      poker,
      secondsLeft,
    });
  }

  private snapshot(): Snapshot {
    const row = this.ctx.storage.sql
      .exec<{ state: string }>("SELECT state FROM snapshot WHERE id = 1")
      .toArray()[0];
    return {
      game: newGame(),
      poker: newPokerGame(),
      deadline: null,
      ...(row ? (JSON.parse(row.state) as Partial<Snapshot>) : {}),
    };
  }

  private save(snapshot: Snapshot) {
    this.ctx.storage.sql.exec(
      `INSERT INTO snapshot (id, state, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      JSON.stringify(snapshot),
      Date.now(),
    );
  }

  // Saves the new game state, mirrors stacks into the seat rows and sets the next timer.
  private commit(
    patch: Partial<Pick<Snapshot, "game" | "poker">>,
    deadline: number | null,
  ) {
    const next: Snapshot = { ...this.snapshot(), ...patch, deadline };
    for (const h of [...next.game.hands, ...next.poker.players]) {
      this.ctx.storage.sql.exec(
        "UPDATE seat SET stack = ? WHERE seat = ? AND pending = 0",
        h.stack,
        h.seat,
      );
    }
    this.save(next);
  }

  private freshDeadline(phase: string, now: number) {
    if (phase === "betting") return now + BET_MS;
    if (phase === "players") return now + TURN_MS;
    if (phase === "results") return now + RESULTS_MS;
    if (["preflop", "flop", "turn", "river"].includes(phase))
      return now + POKER_TURN_MS;
    if (phase === "showdown") return now + SHOWDOWN_MS;
    return null;
  }

  private inRound(seat: number) {
    const snap = this.snapshot();
    return this.room()?.config.game === "poker"
      ? inPokerRound(snap.poker, seat)
      : inRound(snap.game, seat);
  }

  // Poker deals itself as soon as two players have chips.
  private startPokerHand(now: number): boolean {
    const room = this.room();
    const snap = this.snapshot();
    if (room?.config.game !== "poker" || snap.poker.phase !== "waiting")
      return false;
    const poker = startHand(
      snap.poker,
      this.seated(this.seatRows()),
      room.config.blinds,
      room.config.capToShortestStack,
      cryptoRng,
      room.config.boardSkin,
      room.creator,
    );
    if (poker.phase === "waiting") return false;
    this.commit({ poker }, this.freshDeadline(poker.phase, now));
    return true;
  }

  private seated(rows: SeatRow[]) {
    return rows
      .filter((r) => !r.pending)
      .map((r) => ({
        seat: r.seat,
        stack: r.stack,
        skinId: r.skin_id,
        backId: r.back_id,
      }));
  }

  // bet / hit / stand / double. A failed action never changes anything.
  private async playAction(
    ws: WebSocket,
    playerId: string,
    action: { type: string; amount?: number | undefined },
  ) {
    const room = this.room();
    const row = this.seatRows().find(
      (r) => r.player_id === playerId && !r.pending,
    );
    const error = (code: ErrorCode) => send(ws, { t: "error", code });
    if (!room || !row) return error("ILLEGAL_ACTION");
    const snap = this.snapshot();
    const now = Date.now();
    if (room.config.game === "poker") {
      const r = actPoker(snap.poker, row.seat, action);
      if ("error" in r) return error(r.error);
      this.commit({ poker: r.game }, this.freshDeadline(r.game.phase, now));
      await this.rearm();
      this.broadcast();
      return;
    }
    let result: { game: Game } | { error: ErrorCode };
    if (action.type === "bet" && action.amount !== undefined) {
      const open =
        snap.game.phase === "waiting"
          ? startBetting(
              snap.game,
              this.seated(this.seatRows()),
              cryptoRng,
              room.config.boardSkin,
              room.creator,
            )
          : snap.game;
      result = placeBet(open, row.seat, action.amount);
    } else if (
      action.type === "hit" ||
      action.type === "stand" ||
      action.type === "double"
    ) {
      result = act(snap.game, row.seat, action.type);
    } else return error("ILLEGAL_ACTION");
    if ("error" in result) return error(result.error);
    const game = allBet(result.game)
      ? deal(result.game, cryptoRng)
      : result.game;
    // A bet inside a running betting round does not restart its timer.
    const keep =
      action.type === "bet" &&
      game.phase === "betting" &&
      snap.game.phase === "betting";
    this.commit(
      { game },
      keep ? snap.deadline : this.freshDeadline(game.phase, now),
    );
    await this.rearm();
    this.broadcast();
  }

  // Runs the game timer when it is due: deal, auto-stand, or open the next betting round.
  private tickGame(now: number): boolean {
    const snap = this.snapshot();
    const room = this.room();
    if (!room || snap.deadline === null || snap.deadline > now) return false;
    if (room.config.game === "poker") {
      let poker = snap.poker;
      if (poker.phase === "showdown") {
        poker = startHand(
          poker,
          this.seated(this.seatRows()),
          room.config.blinds,
          room.config.capToShortestStack,
          cryptoRng,
          room.config.boardSkin,
          room.creator,
        );
      } else {
        const r = pokerTimeout(poker);
        if ("game" in r) poker = r.game;
      }
      this.commit({ poker }, this.freshDeadline(poker.phase, now));
      return true;
    }
    const { game } = snap;
    let next = game;
    if (game.phase === "betting") next = deal(game, cryptoRng);
    else if (game.phase === "players" && game.turn !== null) {
      const r = act(game, game.turn, "stand");
      if ("game" in r) next = r.game;
    } else if (game.phase === "results") {
      next = startBetting(
        game,
        this.seated(this.seatRows()),
        cryptoRng,
        room.config.boardSkin,
        room.creator,
      );
    }
    // `next === game` would re-arm in the past forever
    this.commit(
      { game: next },
      next === game && game.phase === "players"
        ? now + TURN_MS
        : this.freshDeadline(next.phase, now),
    );
    return true;
  }

  // New `seq`, then one `view` per connected player.
  private broadcast() {
    this.ctx.storage.sql.exec("UPDATE room SET seq = seq + 1");
    const room = this.room();
    if (!room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const player = (ws.deserializeAttachment() as Attachment | null)?.player;
      if (player) {
        send(ws, {
          t: "view",
          seq: room.seq,
          view: this.viewFor(room, player.playerId),
        });
      }
    }
  }

  private hasSocket(playerId: string, except?: WebSocket) {
    return this.ctx
      .getWebSockets()
      .some(
        (ws) =>
          ws !== except &&
          (ws.deserializeAttachment() as Attachment | null)?.player
            ?.playerId === playerId,
      );
  }

  // One alarm for everything: hello timeouts, disconnected seats, unfinished buy-ins.
  private async rearm() {
    let next: number | null = null;
    const soonest = (t: number) => {
      next = Math.min(next ?? t, t);
    };
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.player) soonest((att?.connectedAt ?? 0) + HELLO_TIMEOUT_MS);
    }
    for (const row of this.seatRows()) {
      if (row.deadline !== null) soonest(row.deadline);
    }
    const { deadline } = this.snapshot();
    if (deadline !== null) soonest(deadline);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private setDeadline(playerId: string, deadline: number | null) {
    this.ctx.storage.sql.exec(
      "UPDATE seat SET deadline = ? WHERE player_id = ? AND pending = 0",
      deadline,
      playerId,
    );
  }

  override async fetch(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      connectedAt: Date.now(),
    } satisfies Attachment);
    await this.rearm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.player && (att?.connectedAt ?? 0) + HELLO_TIMEOUT_MS <= now) {
        ws.close(1008, "hello timeout");
      }
    }
    let changed = this.tickGame(now);
    for (const row of this.seatRows()) {
      if (row.deadline === null || row.deadline > now) continue;
      if (row.pending) await this.finishSit(row.seat);
      else if (this.inRound(row.seat)) {
        this.setDeadline(row.player_id, now + PENDING_RETRY_MS); // chips are on the table; try again soon
        continue;
      } else if (!this.hasSocket(row.player_id)) await this.cashOut(row);
      changed = true;
    }
    if (changed) this.broadcast();
    await this.rearm();
  }

  // Completes a buy-in (or retries it: the ledger ref makes that safe). Returns an error code on failure.
  private async finishSit(seat: number): Promise<ErrorCode | null> {
    const row = this.seatRows().find((r) => r.seat === seat);
    if (!row?.pending) return null;
    const res = await this.account(row.token_hash).settle(
      -row.buy_in,
      "buyin",
      `buyin:${row.session}`,
      Date.now(),
    );
    if ("error" in res) {
      this.ctx.storage.sql.exec("DELETE FROM seat WHERE seat = ?", seat);
      return res.error === "NO_ACCOUNT" ? "UNAUTHORIZED" : res.error;
    }
    const p = res.profile;
    this.ctx.storage.sql.exec(
      "UPDATE seat SET name = ?, avatar_id = ?, skin_id = ?, back_id = ?, stack = buy_in, pending = 0, deadline = NULL WHERE seat = ?",
      p.name,
      p.avatarId,
      p.skinId,
      p.backId,
      seat,
    );
    // The player may have left while the buy-in was in flight.
    if (!this.hasSocket(row.player_id)) {
      this.setDeadline(row.player_id, Date.now() + DISCONNECT_MS);
    }
    return null;
  }

  // Returns the stack to the balance, then frees the seat. Safe to repeat (ref `cashout:<session>`).
  private async cashOut(row: SeatRow) {
    // Also with an empty stack: the cash-out closes the account's open seat (which locks the name).
    await this.account(row.token_hash).settle(
      row.stack,
      "cashout",
      `cashout:${row.session}`,
      Date.now(),
    ); // NO_ACCOUNT: the account is gone, so the chips go with it
    this.ctx.storage.sql.exec(
      "DELETE FROM seat WHERE seat = ? AND session = ?",
      row.seat,
      row.session,
    );
    // Leaving may complete a betting round (everyone left has bet).
    const snap = this.snapshot();
    let game = removeSeat(snap.game, row.seat);
    if (allBet(game)) game = deal(game, cryptoRng);
    // keep the running timer unless the round moved on
    const same = game.phase === snap.game.phase && game.turn === snap.game.turn;
    this.commit(
      { game, poker: removePokerSeat(snap.poker, row.seat) },
      same ? snap.deadline : this.freshDeadline(game.phase, Date.now()),
    );
  }

  private async sit(
    ws: WebSocket,
    att: Attachment,
    seat: number,
    buyIn: number,
  ) {
    const room = this.room();
    const player = att.player;
    if (!room || !player || !att.tokenHash) return;
    const range = buyInRange(room.config);
    const rows = this.seatRows();
    const fail = (code: ErrorCode) => send(ws, { t: "error", code });
    if (
      seat >= SEATS[room.config.game] ||
      buyIn < range.min ||
      buyIn > range.max
    ) {
      return fail("ILLEGAL_ACTION");
    }
    if (rows.some((r) => r.player_id === player.playerId)) {
      return fail("ILLEGAL_ACTION");
    }
    if (rows.length >= SEATS[room.config.game]) return fail("ROOM_FULL");
    if (rows.some((r) => r.seat === seat)) return fail("SEAT_TAKEN");

    // Claim the seat before any await, so a concurrent `sit` sees it taken.
    this.ctx.storage.sql.exec(
      `INSERT INTO seat (seat, player_id, token_hash, session, name, avatar_id, skin_id, back_id, stack, buy_in, pending, deadline)
       VALUES (?, ?, ?, ?, ?, 'a1', 'classic', 'ink', 0, ?, 1, ?)`,
      seat,
      player.playerId,
      att.tokenHash,
      crypto.randomUUID(),
      player.name,
      buyIn,
      Date.now() + PENDING_RETRY_MS,
    );
    await this.rearm();
    const error = await this.finishSit(seat);
    await this.rearm();
    if (error) return fail(error);
    this.startPokerHand(Date.now());
    await this.rearm();
    this.broadcast();
  }

  private async stand(ws: WebSocket, playerId: string) {
    const row = this.seatRows().find((r) => r.player_id === playerId);
    if (!row || row.pending || this.inRound(row.seat)) {
      send(ws, { t: "error", code: "ILLEGAL_ACTION" });
      return;
    }
    await this.cashOut(row);
    await this.rearm();
    this.broadcast();
  }

  private async hello(ws: WebSocket, token: string, att: Attachment) {
    const room = this.room();
    const tokenHash = TOKEN.test(token) ? await sha256(token) : null;
    const profile = tokenHash
      ? await this.account(tokenHash).me(Date.now())
      : null;
    if (!room || !tokenHash || !profile) {
      send(ws, { t: "error", code: "UNAUTHORIZED" });
      ws.close(1008, "unauthorized");
      return;
    }
    const player = { playerId: profile.playerId, name: profile.name };
    ws.serializeAttachment({ ...att, tokenHash, player } satisfies Attachment);
    this.setDeadline(player.playerId, null); // reconnecting keeps the seat
    await this.rearm();
    send(ws, {
      t: "welcome",
      seq: room.seq,
      you: player,
      view: this.viewFor(room, player.playerId),
    });
  }

  // Per-connection counter, reset each second. Memory only: a hibernated socket had no traffic anyway.
  private hits = new WeakMap<WebSocket, { start: number; count: number }>();

  // True when the message must be dropped. The first one over the limit gets RATE_LIMITED.
  private limited(ws: WebSocket) {
    const now = Date.now();
    let h = this.hits.get(ws);
    if (!h || now - h.start >= 1000) {
      h = { start: now, count: 0 };
      this.hits.set(ws, h);
    }
    h.count++;
    if (h.count === MESSAGES_PER_SECOND + 1)
      send(ws, { t: "error", code: "RATE_LIMITED" });
    return h.count > MESSAGES_PER_SECOND;
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (this.limited(ws)) return;
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) {
      send(ws, { t: "error", code: "BAD_REQUEST" });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      send(ws, { t: "error", code: "BAD_REQUEST" });
      return;
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      send(ws, { t: "error", code: "BAD_REQUEST" });
      return;
    }
    const msg = parsed.data;
    if (msg.t === "ping") {
      send(ws, { t: "pong" });
      return;
    }
    const att = (ws.deserializeAttachment() as Attachment | null) ?? {
      connectedAt: 0,
    };
    if (msg.t === "hello") {
      if (att.player) send(ws, { t: "error", code: "BAD_REQUEST" });
      else await this.hello(ws, msg.token, att);
      return;
    }
    if (!att.player) {
      send(ws, { t: "error", code: "UNAUTHORIZED" });
      ws.close(1008, "hello first");
      return;
    }
    if (msg.t === "sit") await this.sit(ws, att, msg.seat, msg.buyIn);
    else if (msg.t === "stand") await this.stand(ws, att.player.playerId);
    else if (msg.t === "action") {
      await this.playAction(ws, att.player.playerId, msg.action);
    } else send(ws, { t: "echo", message: msg });
  }

  // Last socket of a seated player gone: start the clock to free the seat.
  private async gone(ws: WebSocket) {
    const player = (ws.deserializeAttachment() as Attachment | null)?.player;
    if (player && !this.hasSocket(player.playerId, ws)) {
      this.setDeadline(player.playerId, Date.now() + DISCONNECT_MS);
    }
    await this.rearm();
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    await this.gone(ws);
    ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, reason);
  }

  override async webSocketError(ws: WebSocket) {
    await this.gone(ws);
  }
}
