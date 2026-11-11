import type { Env as FeltEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends FeltEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/index");
      durableNamespaces: "Table" | "Account";
    }
  }
}
