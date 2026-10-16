import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

fs.mkdirSync(path.dirname(path.resolve(env.dbPath)), { recursive: true });
export const db = new DatabaseSync(env.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,            -- Telegram user id
  name TEXT NOT NULL,
  username TEXT,
  tz TEXT NOT NULL,
  goal_apps INTEGER NOT NULL DEFAULT 5,
  goal_outreach INTEGER NOT NULL DEFAULT 3,
  goal_commits INTEGER NOT NULL DEFAULT 1,
  joined_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS days (
  member INTEGER NOT NULL,
  date TEXT NOT NULL,                -- YYYY-MM-DD in the member's time zone
  apps INTEGER NOT NULL DEFAULT 0,
  outreach INTEGER NOT NULL DEFAULT 0,
  commits INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT '',
  done TEXT NOT NULL DEFAULT '',
  blocker TEXT NOT NULL DEFAULT '',
  in_at TEXT,
  out_at TEXT,
  PRIMARY KEY (member, date)
);
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner INTEGER NOT NULL,            -- member id, or 0 for a shared todo
  text TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT,
  done_by INTEGER
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  by INTEGER NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  for_who INTEGER NOT NULL DEFAULT 0, -- member id, or 0 for both
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lead_status (
  lead INTEGER NOT NULL,
  member INTEGER NOT NULL,
  status TEXT NOT NULL,              -- applied | skip
  PRIMARY KEY (lead, member)
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const now = () => new Date().toISOString();

export type Member = { id: number; name: string; username: string | null; tz: string; goal_apps: number; goal_outreach: number; goal_commits: number; joined_at: string };
export type Day = { member: number; date: string; apps: number; outreach: number; commits: number; plan: string; done: string; blocker: string; in_at: string | null; out_at: string | null };
export type Todo = { id: number; owner: number; text: string; created_by: number; created_at: string; done_at: string | null; done_by: number | null };
export type Lead = { id: number; by: number; title: string; company: string; url: string; note: string; for_who: number; created_at: string; status: Record<string, string> };

export const COUNT_KEYS = ["apps", "outreach", "commits"] as const;
export type CountKey = (typeof COUNT_KEYS)[number];
export const TEXT_KEYS = ["plan", "done", "blocker"] as const;
export type TextKey = (typeof TEXT_KEYS)[number];
export const COUNT_LABEL: Record<CountKey, string> = { apps: "Applications", outreach: "Outreach", commits: "Commits" };

const plain = <T>(row: unknown) => (row ? ({ ...(row as object) } as T) : undefined);

export const members = {
  all: () => (db.prepare("SELECT * FROM members ORDER BY joined_at").all() as unknown[]).map(r => plain<Member>(r)!),
  get: (id: number) => plain<Member>(db.prepare("SELECT * FROM members WHERE id = ?").get(id)),
  upsert(id: number, name: string, username?: string | null) {
    db.prepare(`INSERT INTO members (id, name, username, tz, joined_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username`).run(id, name, username ?? null, env.defaultTz, now());
  },
  setGoals(id: number, g: Partial<Record<CountKey, number>>) {
    const cur = members.get(id); if (!cur) return;
    const v = (k: CountKey, d: number) => Math.max(0, Math.min(50, Math.round(g[k] ?? d)));
    db.prepare("UPDATE members SET goal_apps = ?, goal_outreach = ?, goal_commits = ? WHERE id = ?")
      .run(v("apps", cur.goal_apps), v("outreach", cur.goal_outreach), v("commits", cur.goal_commits), id);
  },
  setTz: (id: number, tz: string) => { db.prepare("UPDATE members SET tz = ? WHERE id = ?").run(tz, id); },
  remove: (id: number) => { db.prepare("DELETE FROM members WHERE id = ?").run(id); },
};

export const goalsOf = (m: Member): Record<CountKey, number> => ({ apps: m.goal_apps, outreach: m.goal_outreach, commits: m.goal_commits });

export const days = {
  get(member: number, date: string): Day {
    db.prepare("INSERT OR IGNORE INTO days (member, date) VALUES (?, ?)").run(member, date);
    return plain<Day>(db.prepare("SELECT * FROM days WHERE member = ? AND date = ?").get(member, date))!;
  },
  find: (member: number, date: string) => plain<Day>(db.prepare("SELECT * FROM days WHERE member = ? AND date = ?").get(member, date)),
  bump(member: number, date: string, key: CountKey, delta: number) {
    if (!COUNT_KEYS.includes(key)) throw new Error("bad key");
    days.get(member, date);
    db.prepare(`UPDATE days SET ${key} = MAX(0, ${key} + ?) WHERE member = ? AND date = ?`).run(Math.round(delta), member, date);
    return days.get(member, date);
  },
  setText(member: number, date: string, key: TextKey, text: string) {
    if (!TEXT_KEYS.includes(key)) throw new Error("bad key");
    days.get(member, date);
    db.prepare(`UPDATE days SET ${key} = ? WHERE member = ? AND date = ?`).run(text.slice(0, 2000), member, date);
  },
  clockIn(member: number, date: string) {
    days.get(member, date);
    db.prepare("UPDATE days SET in_at = COALESCE(in_at, ?) WHERE member = ? AND date = ?").run(now(), member, date);
  },
  clockOut(member: number, date: string) {
    days.get(member, date);
    db.prepare("UPDATE days SET in_at = COALESCE(in_at, ?), out_at = ? WHERE member = ? AND date = ?").run(now(), now(), member, date);
  },
  since: (member: number, from: string) => (db.prepare("SELECT * FROM days WHERE member = ? AND date >= ? ORDER BY date").all(member, from) as unknown[]).map(r => plain<Day>(r)!),
};

export const hitAll = (m: Member, d?: Day) => !!d && COUNT_KEYS.every(k => d[k] >= goalsOf(m)[k]);

export const todos = {
  add(owner: number, text: string, by: number) {
    const r = db.prepare("INSERT INTO todos (owner, text, created_by, created_at) VALUES (?, ?, ?, ?)").run(owner, text.slice(0, 300), by, now());
    return Number(r.lastInsertRowid);
  },
  get: (id: number) => plain<Todo>(db.prepare("SELECT * FROM todos WHERE id = ?").get(id)),
  /** Open todos for this person (theirs + shared). */
  openFor: (member: number) => (db.prepare("SELECT * FROM todos WHERE done_at IS NULL AND owner IN (?, 0) ORDER BY owner = 0, id").all(member) as unknown[]).map(r => plain<Todo>(r)!),
  /** Everything open, plus what was finished in the last 3 days. */
  board: () => (db.prepare("SELECT * FROM todos WHERE done_at IS NULL OR done_at >= ? ORDER BY done_at IS NOT NULL, id").all(new Date(Date.now() - 3 * 86_400_000).toISOString()) as unknown[]).map(r => plain<Todo>(r)!),
  doneToday: (member: number, sinceIso: string) => Number((db.prepare("SELECT COUNT(*) AS n FROM todos WHERE done_by = ? AND done_at >= ?").get(member, sinceIso) as { n: number }).n),
  toggle(id: number, by: number) {
    const t = todos.get(id); if (!t) return undefined;
    if (t.done_at) db.prepare("UPDATE todos SET done_at = NULL, done_by = NULL WHERE id = ?").run(id);
    else db.prepare("UPDATE todos SET done_at = ?, done_by = ? WHERE id = ?").run(now(), by, id);
    return todos.get(id);
  },
  remove: (id: number) => { db.prepare("DELETE FROM todos WHERE id = ?").run(id); },
};

/** Members may change their own todos and shared ones; the partner's are read-only. */
export const canTouchTodo = (t: Todo, member: number) => t.owner === 0 || t.owner === member;

export const leads = {
  add(l: { by: number; title: string; company?: string; url?: string; note?: string; forWho?: number }) {
    const r = db.prepare("INSERT INTO leads (by, title, company, url, note, for_who, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(l.by, l.title.slice(0, 160), (l.company ?? "").slice(0, 100), (l.url ?? "").slice(0, 600), (l.note ?? "").slice(0, 400), l.forWho ?? 0, now());
    return Number(r.lastInsertRowid);
  },
  get(id: number): Lead | undefined {
    const row = plain<Omit<Lead, "status">>(db.prepare("SELECT * FROM leads WHERE id = ?").get(id));
    return row ? { ...row, status: leads.statusOf(id) } : undefined;
  },
  statusOf(id: number) {
    const out: Record<string, string> = {};
    for (const r of db.prepare("SELECT member, status FROM lead_status WHERE lead = ?").all(id) as { member: number; status: string }[]) out[r.member] = r.status;
    return out;
  },
  list(limit = 100): Lead[] {
    return (db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT ?").all(limit) as unknown[]).map(r => {
      const row = plain<Omit<Lead, "status">>(r)!; return { ...row, status: leads.statusOf(row.id) };
    });
  },
  setStatus(id: number, member: number, status: "applied" | "skip" | null) {
    if (status) db.prepare("INSERT INTO lead_status (lead, member, status) VALUES (?, ?, ?) ON CONFLICT(lead, member) DO UPDATE SET status = excluded.status").run(id, member, status);
    else db.prepare("DELETE FROM lead_status WHERE lead = ? AND member = ?").run(id, member);
  },
  remove(id: number) {
    db.prepare("DELETE FROM lead_status WHERE lead = ?").run(id);
    db.prepare("DELETE FROM leads WHERE id = ?").run(id);
  },
  addedSince: (iso: string) => Number((db.prepare("SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?").get(iso) as { n: number }).n),
};

export const kv = {
  get: (key: string) => (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value,
  set: (key: string, value: string) => { db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); },
  del: (key: string) => { db.prepare("DELETE FROM kv WHERE key = ?").run(key); },
  json<T>(key: string, fallback: T): T { const v = kv.get(key); if (!v) return fallback; try { return JSON.parse(v) as T; } catch { return fallback; } },
};

export type Session = { days: string[]; time: string; link: string };
export const session = {
  get: () => kv.json<Session>("session", { days: [], time: "", link: "" }),
  set: (s: Session) => kv.set("session", JSON.stringify(s)),
};

export const groupChatId = () => { const v = kv.get("group_chat_id"); return v ? Number(v) : null; };

export function safeUrl(u: string) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
