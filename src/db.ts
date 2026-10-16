import fs from "node:fs";
import { env } from "./env";

// Tracking data lives in Postgres: Neon in production (DATABASE_URL=postgres://…),
// an in-process PGlite folder for local dev when DATABASE_URL is empty or "pglite:<dir>".

type Row = Record<string, unknown>;
let run: (text: string, params?: unknown[]) => Promise<Row[]>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
    id BIGINT PRIMARY KEY,               -- Telegram user id
    name TEXT NOT NULL,
    username TEXT,
    tz TEXT NOT NULL,
    goal_apps INTEGER NOT NULL DEFAULT 5,
    goal_outreach INTEGER NOT NULL DEFAULT 3,
    goal_commits INTEGER NOT NULL DEFAULT 1,
    joined_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS days (
    member BIGINT NOT NULL,
    date TEXT NOT NULL,                  -- YYYY-MM-DD in the member's time zone
    apps INTEGER NOT NULL DEFAULT 0,
    outreach INTEGER NOT NULL DEFAULT 0,
    commits INTEGER NOT NULL DEFAULT 0,
    plan TEXT NOT NULL DEFAULT '',
    done TEXT NOT NULL DEFAULT '',
    blocker TEXT NOT NULL DEFAULT '',
    in_at TEXT,
    out_at TEXT,
    PRIMARY KEY (member, date)
  )`,
  `CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    owner BIGINT NOT NULL,               -- member id, or 0 for a shared todo
    text TEXT NOT NULL,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    done_at TEXT,
    done_by BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS lead_status (
    lead TEXT NOT NULL,                  -- Apleo opportunity id
    member BIGINT NOT NULL,
    status TEXT NOT NULL,                -- applied | skip
    PRIMARY KEY (lead, member)
  )`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export async function connectDb() {
  const url = env.databaseUrl;
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pg = (await import("pg")).default;
    pg.types.setTypeParser(20, v => Number(v)); // BIGINT → number (Telegram ids fit)
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    run = async (text, params) => (await pool.query(text, params as unknown[])).rows;
    console.log("Tracking store: Postgres");
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = url.replace(/^pglite:/, "") || "./data/pglite";
    fs.mkdirSync(dir, { recursive: true });
    const db = new PGlite(dir, { parsers: { 20: (v: string) => Number(v) } });
    run = async (text, params) => (await db.query<Row>(text, params)).rows;
    console.log(`Tracking store: local PGlite at ${dir} (set DATABASE_URL to use Neon)`);
  }
  for (const stmt of SCHEMA) await run(stmt);
}

export const q = <T = Row>(text: string, params: unknown[] = []) => run(text, params) as Promise<T[]>;
export const one = async <T = Row>(text: string, params: unknown[] = []) => (await q<T>(text, params))[0];
