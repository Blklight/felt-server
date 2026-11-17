import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import type { Account } from "./durable/Account";
import type { Env } from "./env";
import { fail, ok } from "./http";
import { CreateAccountBody, PatchMeBody, TOKEN } from "./protocol";
import { newToken, sha256 } from "./token";

export type App = {
  Bindings: Env;
  Variables: { stub: DurableObjectStub<Account> };
};

// Body is optional JSON; an empty body counts as {}.
export async function readBody(req: Request): Promise<unknown | undefined> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "body");
    if (key in fields) continue;
    fields[key] =
      issue.code === "too_small"
        ? "too_short"
        : issue.code === "too_big"
          ? "too_long"
          : "invalid";
  }
  return fields;
}

export const accounts = new Hono<App>();

accounts.post("/v1/accounts", async (c) => {
  const body = CreateAccountBody.safeParse(await readBody(c.req.raw));
  if (!body.success) {
    return c.json(fail("VALIDATION_ERROR", "", fieldErrors(body.error)), 400);
  }
  const token = newToken();
  const tokenHash = await sha256(token);
  const playerId = crypto.randomUUID();
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(tokenHash));
  const profile = await stub.create(
    {
      playerId,
      tokenHash,
      name: body.data.name,
      avatarId: body.data.avatarId ?? "a1",
    },
    Date.now(),
  );
  return c.json(ok({ playerId, token, profile }), 201);
});

// 401 means "invalid account" (no refresh exists).
export const requireAccount = createMiddleware<App>(async (c, next) => {
  const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token || !TOKEN.test(token)) return c.json(fail("UNAUTHORIZED"), 401);
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(await sha256(token)));
  if (!(await stub.exists())) return c.json(fail("UNAUTHORIZED"), 401);
  c.set("stub", stub);
  await next();
});
accounts.use("/v1/me", requireAccount);

accounts.get("/v1/me", async (c) =>
  c.json(ok(await c.var.stub.me(Date.now()))),
);

accounts.patch("/v1/me", async (c) => {
  const body = PatchMeBody.safeParse(await readBody(c.req.raw));
  if (!body.success) {
    return c.json(fail("VALIDATION_ERROR", "", fieldErrors(body.error)), 400);
  }
  const profile = await c.var.stub.update(body.data);
  if (profile && "locked" in profile) {
    const fields = Object.fromEntries(profile.locked.map((f) => [f, "locked"]));
    return c.json(fail("VALIDATION_ERROR", "", fields), 409);
  }
  return c.json(ok(profile));
});

accounts.delete("/v1/me", async (c) => {
  await c.var.stub.destroy();
  return c.json(ok(null));
});
