export type Tier = "free" | "pro" | "enterprise";
export type Mode = "off" | "log-only" | "enforce";
export type Principal =
  | { kind: "tenant"; tenantId: string; tier: Tier }
  | { kind: "service"; tenantId: string }
  | { kind: "admin" };

export interface RedisStore {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  hSet(key: string, field: string, value: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hVals(key: string): Promise<string[]>;
}

export interface Logger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

declare global {
  namespace Express {
    interface Locals {
      principal?: Principal;
    }
  }
}
