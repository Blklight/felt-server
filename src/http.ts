import type { ErrorCode } from "./protocol";

export const ok = <T>(data: T) => ({ data, error: null, message: "" });

export const fail = (code: ErrorCode, message = "") => ({
  data: null,
  error: { code, message },
  message,
});
