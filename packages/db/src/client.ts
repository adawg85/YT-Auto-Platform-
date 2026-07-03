import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

let singleton: Db | undefined;

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return drizzle(client, { schema });
}

/** Process-wide client for apps; tests should call createDb() themselves. */
export function getDb(): Db {
  singleton ??= createDb();
  return singleton;
}
