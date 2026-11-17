import { Hono } from "hono";
import { type App, fieldErrors, readBody, requireAccount } from "./accounts";
import { fail, ok } from "./http";
import {
  CreateRoomBody,
  isRoomCode,
  ROOM_ALPHABET,
  RoomConfig,
} from "./protocol";

// 256 is a multiple of the 32-char alphabet, so a plain modulo is unbiased.
const newCode = () =>
  [...crypto.getRandomValues(new Uint8Array(5))]
    .map((b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length])
    .join("");

export const rooms = new Hono<App>();

rooms.post("/v1/rooms", requireAccount, async (c) => {
  const raw = CreateRoomBody.safeParse(await readBody(c.req.raw));
  if (!raw.success) {
    return c.json(fail("VALIDATION_ERROR", "", fieldErrors(raw.error)), 400);
  }
  const body = RoomConfig.safeParse({
    ...raw.data.config,
    game: raw.data.game,
  });
  if (!body.success) {
    return c.json(fail("VALIDATION_ERROR", "", fieldErrors(body.error)), 400);
  }
  const profile = await c.var.stub.me(Date.now());
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const table = c.env.TABLE.get(c.env.TABLE.idFromName(code));
    if (
      await table.create(
        body.data,
        {
          skinId: profile?.skinId ?? "classic",
          backId: profile?.backId ?? "ink",
        },
        Date.now(),
      )
    ) {
      return c.json(ok({ code }), 201);
    }
  }
  return c.json(fail("BAD_REQUEST", "Could not allocate a room code"), 503);
});

rooms.get("/v1/rooms/:code", async (c) => {
  const code = c.req.param("code");
  const info = isRoomCode(code)
    ? await c.env.TABLE.get(c.env.TABLE.idFromName(code)).info()
    : null;
  if (!info) return c.json(fail("ROOM_NOT_FOUND"), 404);
  if (info.taken >= info.seats) return c.json(fail("ROOM_FULL"), 409);
  return c.json(ok({ code, ...info }));
});
