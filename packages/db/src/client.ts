import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

let singleton: Db | undefined;

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  // Managed Postgres (Render/Neon/Supabase) needs TLS on external
  // connections: append ?sslmode=require to the URL or set DATABASE_SSL.
  const wantSsl =
    process.env.DATABASE_SSL === "require" || /sslmode=require/.test(url);
  const client = postgres(url, {
    max: Number(process.env.DATABASE_POOL_MAX ?? "10"),
    onnotice: () => {},
    ...(wantSsl ? { ssl: "require" as const } : {}),
  });
  return drizzle(client, { schema });
}

/** Process-wide client for apps; tests should call createDb() themselves. */
export function getDb(): Db {
  singleton ??= createDb();
  return singleton;
}
