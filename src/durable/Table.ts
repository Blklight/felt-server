import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  ClientMessage,
  MAX_MESSAGE_BYTES,
  PING,
  PONG,
  type ServerMessage,
} from "../protocol";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

// Codes a peer reports but that may not be sent back in a close frame (RFC 6455, 7.4.1).
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

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

  override async fetch(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
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
    if (parsed.data.t === "ping") {
      send(ws, { t: "pong" });
      return;
    }
    send(ws, { t: "echo", message: parsed.data });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, reason);
  }
}
