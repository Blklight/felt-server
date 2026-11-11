import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { fail, ok } from "./http";
import { isRoomCode } from "./protocol";

export { Account } from "./durable/Account";
export { Table } from "./durable/Table";

const allowedOrigins = (env: Env) =>
  env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim());

const app = new Hono<{ Bindings: Env }>();

app.use("/v1/*", (c, next) =>
  cors({
    origin: allowedOrigins(c.env),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE"],
  })(c, next),
);

app.get("/health", (c) => c.json(ok({ ok: true })));

app.get("/v1/rooms/:code/ws", (c) => {
  const code = c.req.param("code");
  if (!isRoomCode(code)) return c.json(fail("ROOM_NOT_FOUND"), 404);
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json(fail("BAD_REQUEST", "Expected a WebSocket upgrade"), 426);
  }
  const origin = c.req.header("Origin");
  if (origin && !allowedOrigins(c.env).includes(origin)) {
    return c.json(fail("FORBIDDEN_ORIGIN"), 403);
  }
  const table = c.env.TABLE.get(c.env.TABLE.idFromName(code));
  return table.fetch(c.req.raw);
});

app.notFound((c) => c.json(fail("NOT_FOUND"), 404));

export default app;
