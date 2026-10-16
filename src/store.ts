import { env } from "./env";
import { one, q } from "./db";

// Tracking only: members, days, todos, who applied to which lead, settings.
// The leads themselves live in Apleo (see apleo.ts).

const now = () => new Date().toISOString();

export type Member = { id: number; name: string; username: string | null; tz: string; goal_apps: number; goal_outreach: number; goal_commits: number; joined_at: string; focus: string };
export type Day = { member: number; date: string; apps: number; outreach: number; commits: number; plan: string; done: string; blocker: string; in_at: string | null; out_at: string | null };
export type Todo = { id: number; owner: number; text: string; created_by: number; created_at: string; done_at: string | null; done_by: number | null };

export const COUNT_KEYS = ["apps", "outreach", "commits"] as const;
export type CountKey = (typeof COUNT_KEYS)[number];
export const TEXT_KEYS = ["plan", "done", "blocker"] as const;
export type TextKey = (typeof TEXT_KEYS)[number];
export const COUNT_LABEL: Record<CountKey, string> = { apps: "Applications", outreach: "Outreach", commits: "Commits" };

export const members = {
  all: () => q<Member>("SELECT * FROM members ORDER BY joined_at"),
  get: (id: number) => one<Member>("SELECT * FROM members WHERE id = $1", [id]),
  async upsert(id: number, name: string, username?: string | null) {
    await q(`INSERT INTO members (id, name, username, tz, joined_at) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username`, [id, name, username ?? null, env.defaultTz, now()]);
  },
  async setGoals(id: number, g: Partial<Record<CountKey, number>>) {
    const cur = await members.get(id); if (!cur) return;
    const v = (k: CountKey, d: number) => Math.max(0, Math.min(50, Math.round(Number.isFinite(g[k]) ? g[k]! : d)));
    await q("UPDATE members SET goal_apps = $1, goal_outreach = $2, goal_commits = $3 WHERE id = $4",
      [v("apps", cur.goal_apps), v("outreach", cur.goal_outreach), v("commits", cur.goal_commits), id]);
  },
  setTz: (id: number, tz: string) => q("UPDATE members SET tz = $1 WHERE id = $2", [tz, id]),
  setFocus: (id: number, focus: string) => q("UPDATE members SET focus = $1 WHERE id = $2", [focus.slice(0, 500), id]),
};

export const goalsOf = (m: Member): Record<CountKey, number> => ({ apps: m.goal_apps, outreach: m.goal_outreach, commits: m.goal_commits });

export const days = {
  async get(member: number, date: string): Promise<Day> {
    await q("INSERT INTO days (member, date) VALUES ($1, $2) ON CONFLICT DO NOTHING", [member, date]);
    return (await one<Day>("SELECT * FROM days WHERE member = $1 AND date = $2", [member, date]))!;
  },
  find: (member: number, date: string) => one<Day>("SELECT * FROM days WHERE member = $1 AND date = $2", [member, date]),
  async bump(member: number, date: string, key: CountKey, delta: number) {
    if (!COUNT_KEYS.includes(key)) throw new Error("bad key");
    await days.get(member, date);
    await q(`UPDATE days SET ${key} = GREATEST(0, ${key} + $1) WHERE member = $2 AND date = $3`, [Math.round(delta), member, date]);
    return days.get(member, date);
  },
  async setText(member: number, date: string, key: TextKey, text: string) {
    if (!TEXT_KEYS.includes(key)) throw new Error("bad key");
    await days.get(member, date);
    await q(`UPDATE days SET ${key} = $1 WHERE member = $2 AND date = $3`, [text.slice(0, 2000), member, date]);
  },
  async clockIn(member: number, date: string) {
    await days.get(member, date);
    await q("UPDATE days SET in_at = COALESCE(in_at, $1) WHERE member = $2 AND date = $3", [now(), member, date]);
  },
  async clockOut(member: number, date: string) {
    await days.get(member, date);
    await q("UPDATE days SET in_at = COALESCE(in_at, $1), out_at = $1 WHERE member = $2 AND date = $3", [now(), member, date]);
  },
  since: (member: number, from: string) => q<Day>("SELECT * FROM days WHERE member = $1 AND date >= $2 ORDER BY date", [member, from]),
};

export const hitAll = (m: Member, d?: Day) => !!d && COUNT_KEYS.every(k => d[k] >= goalsOf(m)[k]);

export const todos = {
  async add(owner: number, text: string, by: number) {
    return (await one<{ id: number }>("INSERT INTO todos (owner, text, created_by, created_at) VALUES ($1, $2, $3, $4) RETURNING id", [owner, text.slice(0, 300), by, now()]))!.id;
  },
  get: (id: number) => Number.isFinite(id) ? one<Todo>("SELECT * FROM todos WHERE id = $1", [id]) : Promise.resolve(undefined),
  /** Open todos for this person (theirs + shared). */
  openFor: (member: number) => q<Todo>("SELECT * FROM todos WHERE done_at IS NULL AND owner IN ($1, 0) ORDER BY owner = 0, id", [member]),
  /** Everything open, plus what was finished in the last 3 days. */
  board: () => q<Todo>("SELECT * FROM todos WHERE done_at IS NULL OR done_at >= $1 ORDER BY done_at IS NOT NULL, id", [new Date(Date.now() - 3 * 86_400_000).toISOString()]),
  async toggle(id: number, by: number) {
    const t = await todos.get(id); if (!t) return undefined;
    if (t.done_at) await q("UPDATE todos SET done_at = NULL, done_by = NULL WHERE id = $1", [id]);
    else await q("UPDATE todos SET done_at = $1, done_by = $2 WHERE id = $3", [now(), by, id]);
    return todos.get(id);
  },
  remove: (id: number) => q("DELETE FROM todos WHERE id = $1", [id]),
};

/** Members may change their own todos and shared ones; the partner's are read-only. */
export const canTouchTodo = (t: Todo, member: number) => t.owner === 0 || t.owner === member;

/** Who applied to (or skipped) which Apleo lead. */
export const leadStatus = {
  async all(): Promise<Record<string, Record<string, string>>> {
    const out: Record<string, Record<string, string>> = {};
    for (const r of await q<{ lead: string; member: number; status: string }>("SELECT lead, member, status FROM lead_status")) (out[r.lead] ??= {})[r.member] = r.status;
    return out;
  },
  async of(lead: string) { return (await leadStatus.all())[lead] ?? {}; },
  async set(lead: string, member: number, status: "applied" | "skip" | null) {
    if (status) await q("INSERT INTO lead_status (lead, member, status) VALUES ($1, $2, $3) ON CONFLICT (lead, member) DO UPDATE SET status = EXCLUDED.status", [lead, member, status]);
    else await q("DELETE FROM lead_status WHERE lead = $1 AND member = $2", [lead, member]);
  },
  forget: (lead: string) => q("DELETE FROM lead_status WHERE lead = $1", [lead]),
};

export const kv = {
  get: async (key: string) => (await one<{ value: string }>("SELECT value FROM kv WHERE key = $1", [key]))?.value,
  set: (key: string, value: string) => q("INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]),
  del: (key: string) => q("DELETE FROM kv WHERE key = $1", [key]),
  async json<T>(key: string, fallback: T): Promise<T> { const v = await kv.get(key); if (!v) return fallback; try { return JSON.parse(v) as T; } catch { return fallback; } },
};

export type Session = { days: string[]; time: string; link: string };
export const session = {
  get: () => kv.json<Session>("session", { days: [], time: "", link: "" }),
  set: (s: Session) => kv.set("session", JSON.stringify(s)),
};

export const groupChatId = async () => { const v = await kv.get("group_chat_id"); return v ? Number(v) : null; };

export function safeUrl(u: string) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
