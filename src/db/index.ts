import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type DB = ReturnType<typeof drizzle<typeof schema>>;

let instance: DB | null = null;

export function initDb(d1: D1Database): DB {
  instance = drizzle(d1, { schema });
  return instance;
}

/**
 * Proxy that forwards to the D1-backed instance initialized per-request via
 * initDb(). Lets every module keep using `db.select()...` unchanged instead
 * of threading the instance through every function signature.
 */
export const db = new Proxy({} as DB, {
  get(_target, prop, _receiver) {
    if (!instance) {
      throw new Error("Database not initialized — call initDb(env.DB) before using `db`");
    }
    const value = (instance as any)[prop];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
