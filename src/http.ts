import type { ErrorCode } from "./protocol";

export const ok = <T>(data: T) => ({ data, error: null, message: "" });

export const fail = (
  code: ErrorCode,
  message = "",
  fields?: Record<string, string>,
) => ({
  data: null,
  error: fields ? { code, message, fields } : { code, message },
  message,
});
