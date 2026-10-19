import { env } from "./env";
import { NO_ID, col, nextId } from "./db";

// Tracking only: members, days, todos, who applied to which lead, settings.
// The leads themselves live in Apleo (see apleo.ts).

const now = () => new Date().toISOString();

export type Member = { id: number; name: string; username: string | null; tz: string; goal_apps: number; goal_outreach: number; goal_commits: number; joined_at: string; focus: string; goal_posts: number; profile?: string };
export type Day = { member: number; date: string; apps: number; outreach: number; commits: number; plan: string; done: string; blocker: string; in_at: string | null; out_at: string | null };
export type Todo = { id: number; owner: number; text: string; created_by: number; created_at: string; done_at: string | null; done_by: number | null };

export const COUNT_KEYS = ["apps", "outreach", "commits"] as const;
export type CountKey = (typeof COUNT_KEYS)[number];
export const TEXT_KEYS = ["plan", "done", "blocker"] as const;
export type TextKey = (typeof TEXT_KEYS)[number];
export const COUNT_LABEL: Record<CountKey, string> = { apps: "Applications", outreach: "Outreach", commits: "Commits" };

type MemberDoc = Member & { _id: number };
const M = () => col<MemberDoc>("members");

export const members = {
  all: () => M().find({}, NO_ID).sort({ joined_at: 1 }).toArray() as Promise<Member[]>,
  get: async (id: number) => ((await M().findOne({ _id: id }, NO_ID)) as Member | null) ?? undefined,
  async upsert(id: number, name: string, username?: string | null) {
    await M().updateOne({ _id: id }, {
      $set: { name, username: username ?? null },
      $setOnInsert: { id, tz: env.defaultTz, goal_apps: 5, goal_outreach: 3, goal_commits: 1, goal_posts: 3, focus: "", joined_at: now() },
    }, { upsert: true });
  },
  async setGoals(id: number, g: Partial<Record<CountKey, number>>) {
    const cur = await members.get(id); if (!cur) return;
    const v = (k: CountKey, d: number) => Math.max(0, Math.min(50, Math.round(Number.isFinite(g[k]) ? g[k]! : d)));
    await M().updateOne({ _id: id }, { $set: { goal_apps: v("apps", cur.goal_apps), goal_outreach: v("outreach", cur.goal_outreach), goal_commits: v("commits", cur.goal_commits) } });
  },
  setTz: (id: number, tz: string) => M().updateOne({ _id: id }, { $set: { tz } }),
  setPostGoal: (id: number, n: number) => M().updateOne({ _id: id }, { $set: { goal_posts: Math.max(0, Math.min(21, Math.round(n))) } }),
  setProfile: (id: number, slug: string) => M().updateOne({ _id: id }, { $set: { profile: slug } }),
  setFocus: (id: number, focus: string) => M().updateOne({ _id: id }, { $set: { focus: focus.slice(0, 500) } }),
};

/** Which Apleo triage profile this member's picks are filed under. The admin is "surafel" unless set. */
export const profileOf = (m: Member) => m.profile || (m.id === env.adminId ? "surafel" : "");

export const goalsOf = (m: Member): Record<CountKey, number> => ({ apps: m.goal_apps, outreach: m.goal_outreach, commits: m.goal_commits });

type DayDoc = Day & { _id: string };
const D = () => col<DayDoc>("days");
const dayId = (member: number, date: string) => `${member}:${date}`;

export const days = {
  async get(member: number, date: string): Promise<Day> {
    await D().updateOne({ _id: dayId(member, date) }, {
      $setOnInsert: { member, date, apps: 0, outreach: 0, commits: 0, plan: "", done: "", blocker: "", in_at: null, out_at: null },
    }, { upsert: true });
    return (await D().findOne({ _id: dayId(member, date) }, NO_ID)) as Day;
  },
  find: async (member: number, date: string) => ((await D().findOne({ _id: dayId(member, date) }, NO_ID)) as Day | null) ?? undefined,
  async bump(member: number, date: string, key: CountKey, delta: number) {
    if (!COUNT_KEYS.includes(key)) throw new Error("bad key");
    await days.get(member, date);
    await D().updateOne({ _id: dayId(member, date) }, [{ $set: { [key]: { $max: [0, { $add: [`$${key}`, Math.round(delta)] }] } } }]);
    return days.get(member, date);
  },
  async setText(member: number, date: string, key: TextKey, text: string) {
    if (!TEXT_KEYS.includes(key)) throw new Error("bad key");
    await days.get(member, date);
    await D().updateOne({ _id: dayId(member, date) }, { $set: { [key]: text.slice(0, 2000) } });
  },
  async clockIn(member: number, date: string) {
    await days.get(member, date);
    await D().updateOne({ _id: dayId(member, date) }, [{ $set: { in_at: { $ifNull: ["$in_at", now()] } } }]);
  },
  async clockOut(member: number, date: string) {
    await days.get(member, date);
    const t = now();
    await D().updateOne({ _id: dayId(member, date) }, [{ $set: { in_at: { $ifNull: ["$in_at", t] }, out_at: t } }]);
  },
  since: (member: number, from: string) => D().find({ member, date: { $gte: from } }, NO_ID).sort({ date: 1 }).toArray() as Promise<Day[]>,
};

export const hitAll = (m: Member, d?: Day) => !!d && COUNT_KEYS.every(k => d[k] >= goalsOf(m)[k]);

type TodoDoc = Todo & { _id: number };
const T = () => col<TodoDoc>("todos");

export const todos = {
  async add(owner: number, text: string, by: number) {
    const id = await nextId("todos");
    await T().insertOne({ _id: id, id, owner, text: text.slice(0, 300), created_by: by, created_at: now(), done_at: null, done_by: null });
    return id;
  },
  get: async (id: number) => (Number.isFinite(id) ? ((await T().findOne({ _id: id }, NO_ID)) as Todo | null) ?? undefined : undefined),
  /** Open todos for this person (theirs first, then shared). */
  async openFor(member: number) {
    const list = (await T().find({ done_at: null, owner: { $in: [member, 0] } }, NO_ID).toArray()) as Todo[];
    return list.sort((a, b) => Number(a.owner === 0) - Number(b.owner === 0) || a.id - b.id);
  },
  /** Everything open, plus what was finished in the last 3 days. */
  async board() {
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const list = (await T().find({ $or: [{ done_at: null }, { done_at: { $gte: since } }] }, NO_ID).toArray()) as Todo[];
    return list.sort((a, b) => Number(!!a.done_at) - Number(!!b.done_at) || a.id - b.id);
  },
  async toggle(id: number, by: number) {
    const t = await todos.get(id); if (!t) return undefined;
    await T().updateOne({ _id: id }, { $set: t.done_at ? { done_at: null, done_by: null } : { done_at: now(), done_by: by } });
    return todos.get(id);
  },
  remove: (id: number) => T().deleteOne({ _id: id }),
};

/** Members may change their own todos and shared ones; teammates' are read-only. */
export const canTouchTodo = (t: Todo, member: number) => t.owner === 0 || t.owner === member;

/** Who applied to (or skipped) which Apleo lead. */
type StatusDoc = { _id: string; lead: string; member: number; status: string };
const LS = () => col<StatusDoc>("lead_status");
export const leadStatus = {
  async all(): Promise<Record<string, Record<string, string>>> {
    const out: Record<string, Record<string, string>> = {};
    for (const r of await LS().find({}).toArray()) (out[r.lead] ??= {})[r.member] = r.status;
    return out;
  },
  async of(lead: string) {
    const out: Record<string, string> = {};
    for (const r of await LS().find({ lead }).toArray()) out[r.member] = r.status;
    return out;
  },
  async set(lead: string, member: number, status: "applied" | "skip" | null) {
    const _id = `${lead}:${member}`;
    if (status) await LS().updateOne({ _id }, { $set: { lead, member, status } }, { upsert: true });
    else await LS().deleteOne({ _id });
  },
  forget: (lead: string) => LS().deleteMany({ lead }),
};

type KvDoc = { _id: string; value: string };
export const KV = () => col<KvDoc>("kv");
export const kv = {
  get: async (key: string) => (await KV().findOne({ _id: key }))?.value,
  set: (key: string, value: string) => KV().updateOne({ _id: key }, { $set: { value } }, { upsert: true }),
  del: (key: string) => KV().deleteOne({ _id: key }),
  async json<T>(key: string, fallback: T): Promise<T> { const v = await kv.get(key); if (!v) return fallback; try { return JSON.parse(v) as T; } catch { return fallback; } },
  /** All entries whose key starts with `prefix`. */
  async startingWith(prefix: string) { return (await KV().find({ _id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } }).toArray()).map(r => ({ key: r._id, value: r.value })); },
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
