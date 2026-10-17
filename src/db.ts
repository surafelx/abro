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
  `ALTER TABLE members ADD COLUMN IF NOT EXISTS focus TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS feed_items (
    id SERIAL PRIMARY KEY,
    day TEXT NOT NULL,                   -- YYYY-MM-DD (DEFAULT_TZ) it was made for
    kind TEXT NOT NULL,                  -- news | learn | try | idea | improve
    for_member BIGINT NOT NULL DEFAULT 0, -- member id, or 0 for both
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS works (
    id SERIAL PRIMARY KEY,
    member BIGINT NOT NULL,
    kind TEXT NOT NULL,                  -- project | post | skill
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    stack TEXT NOT NULL DEFAULT '',      -- comma-separated
    links TEXT NOT NULL DEFAULT '{}',    -- JSON {live, code, post}
    status TEXT NOT NULL DEFAULT 'doing', -- doing | done
    feed_item INTEGER,
    portfolio_state TEXT NOT NULL DEFAULT 'none', -- none | draft | live
    portfolio_url TEXT NOT NULL DEFAULT '',
    in_resume BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS drafts (
    id SERIAL PRIMARY KEY,
    member BIGINT NOT NULL,
    work INTEGER,
    feed_item INTEGER,
    platform TEXT NOT NULL,              -- linkedin | x | devto
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS profiles (member BIGINT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS resumes (member BIGINT PRIMARY KEY, data TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', generated_at TEXT NOT NULL, published_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS portfolio_links (member BIGINT PRIMARY KEY, url TEXT NOT NULL, key_enc TEXT NOT NULL)`,
  `ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`, // draft | posted
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS posted_url TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS posted_at TEXT`,
  `ALTER TABLE members ADD COLUMN IF NOT EXISTS goal_posts INTEGER NOT NULL DEFAULT 3`, // posts per week
  `CREATE TABLE IF NOT EXISTS feed_saves (
    item INTEGER NOT NULL,
    member BIGINT NOT NULL,
    PRIMARY KEY (item, member)
  )`,
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
