import type { Account } from "./durable/Account";
import type { Table } from "./durable/Table";

export interface Env {
  TABLE: DurableObjectNamespace<Table>;
  ACCOUNT: DurableObjectNamespace<Account>;
  ALLOWED_ORIGINS: string;
}
