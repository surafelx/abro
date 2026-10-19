// The Feed: daily picks (news, things to learn, tools to try) chosen for each person on the team,
// "fresh ideas" (original ideas made by combining what's trending with each person's focus and
// week, each with a note on how it came up), plus on Sundays a "what to improve" note per person
// and project ideas sized to their portfolio.
//
// Sources are public APIs: Hacker News front page (Algolia), dev.to's top posts this week,
// and the GitHub repos that gained the most stars this week. The AI only picks from that list
// and explains why, so every link is real. Without an AI key the feed still fills with the
// top items from each source.
import { env } from "./env";
import { NO_ID, col, nextId } from "./db";
import { askJson, aiReady } from "./ai";
import { COUNT_KEYS, Member, days, goalsOf, hitAll, leadStatus, members, todos } from "./store";
import { dayKey, lastDays } from "./time";

export type FeedKind = "news" | "learn" | "try" | "idea" | "spark" | "improve";
export type FeedItem = { id: number; day: string; kind: FeedKind; for_member: number; title: string; url: string; body: string; source: string; created_at: string; origin: string };
type Candidate = { title: string; url: string; source: string; score: number; blurb?: string };

const now = () => new Date().toISOString();
const FI = () => col<FeedItem & { _id: number }>("feed_items");
const FS = () => col<{ _id: string; item: number; member: number }>("feed_saves");
const UA = { "user-agent": "Abro-feed/0.1 (+https://github.com)" };

async function getJson<T>(url: string, headers: Record<string, string> = {}, retry = 1): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(15_000) });
    if (r.ok) return (await r.json()) as T;
    if (r.status < 500) return null;
  } catch { /* network blip: retry below */ }
  if (retry > 0) { await new Promise(res => setTimeout(res, 1500)); return getJson<T>(url, headers, retry - 1); }
  console.warn("feed source failed:", url.split("?")[0]);
  return null;
}

async function sources(): Promise<Candidate[]> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const [hn, devto, gh] = await Promise.all([
    getJson<{ hits: { title: string; url: string | null; objectID: string; points: number }[] }>("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30"),
    getJson<{ title: string; url: string; description: string; positive_reactions_count: number; tag_list: string[] }[]>("https://dev.to/api/articles?top=7&per_page=30"),
    getJson<{ items: { full_name: string; html_url: string; description: string | null; stargazers_count: number; language: string | null }[] }>(
      `https://api.github.com/search/repositories?q=created:>${weekAgo}&sort=stars&order=desc&per_page=20`, { accept: "application/vnd.github+json" }),
  ]);
  const out: Candidate[] = [];
  for (const h of hn?.hits ?? []) out.push({ title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, source: "Hacker News", score: h.points });
  for (const d of devto ?? []) out.push({ title: d.title, url: d.url, source: "dev.to", score: d.positive_reactions_count, blurb: [d.description, d.tag_list?.join(", ")].filter(Boolean).join(" · ").slice(0, 200) });
  for (const g of gh?.items ?? []) out.push({ title: g.full_name, url: g.html_url, source: "GitHub", score: g.stargazers_count, blurb: [g.description, g.language].filter(Boolean).join(" · ").slice(0, 200) });
  return out;
}

async function insert(day: string, kind: FeedKind, forMember: number, title: string, url: string, body: string, source: string, origin = "") {
  const id = await nextId("feed_items");
  await FI().insertOne({ _id: id, id, day, kind, for_member: forMember, title: title.slice(0, 200), url: url.slice(0, 600), body: body.slice(0, 1500), source: source.slice(0, 40), created_at: now(), origin: origin.slice(0, 2000) });
}

const profileOf = (m: Member, key: string) => ({ key, name: m.name, focus: m.focus || "(not set: assume a software developer looking for remote work)" });

let building = false;

/** Daily picks. Returns how many items were added. */
export async function buildDaily(): Promise<{ added: number; via: string }> {
  if (building) return { added: 0, via: "busy" };
  building = true;
  try {
    const day = dayKey(env.defaultTz);
    const ms = await members.all();
    const seen = new Set((await FI().find({ created_at: { $gte: new Date(Date.now() - 30 * 86_400_000).toISOString() } }, { projection: { url: 1 } }).toArray()).map(r => r.url));
    const cands = (await sources()).filter(c => c.url && !seen.has(c.url));
    if (!cands.length) return { added: 0, via: "no new items" };
    const keyOf = new Map(ms.map((m, i) => [`p${i + 1}`, m.id]));

    if (aiReady() && ms.length) {
      try {
        const { data, via } = await askJson<{ picks: { i: number; kind: string; for: string; why: string }[] }>({
          system: "You curate a short daily feed for people who are job hunting and building their portfolios together. You only pick from the numbered candidates given. You answer with JSON only.",
          prompt: `People:\n${JSON.stringify(ms.map((m, i) => profileOf(m, `p${i + 1}`)))}\n\nCandidates:\n${cands.map((c, i) => `${i}. [${c.source}] ${c.title}${c.blurb ? ` — ${c.blurb}` : ""}`).join("\n")}\n\n` +
            `Pick up to 8 candidates that would most help these people get hired or level up. For each pick give:\n` +
            `- "i": the candidate number\n- "kind": "news" (worth knowing), "learn" (a skill or concept to study) or "try" (a tool or repo to try this week)\n` +
            `- "for": "both" or one person's key\n- "why": one plain sentence on why it matters to them specifically. No hype.\n` +
            `Skip politics, drama and anything unrelated to their work. Return {"picks":[...]}.`,
        });
        let added = 0;
        for (const p of (data.picks ?? []).slice(0, 8)) {
          const c = cands[p.i];
          if (!c) continue;
          const kind = (["news", "learn", "try"].includes(p.kind) ? p.kind : "news") as FeedKind;
          await insert(day, kind, keyOf.get(p.for) ?? 0, c.title, c.url, String(p.why ?? ""), c.source);
          added++;
        }
        if (added) {
          const sparks = await buildSparks(cands).catch(e => { console.warn("fresh ideas failed:", (e as Error).message); return 0; });
          return { added: added + sparks, via };
        }
      } catch (e) { console.warn("feed AI failed, using top items:", (e as Error).message); }
    }

    // No AI (or it failed): top items per source.
    const top = (src: string, n: number) => cands.filter(c => c.source === src).sort((a, b) => b.score - a.score).slice(0, n);
    const plain = [...top("Hacker News", 3).map(c => ["news", c] as const), ...top("dev.to", 3).map(c => ["learn", c] as const), ...top("GitHub", 2).map(c => ["try", c] as const)];
    for (const [kind, c] of plain) await insert(day, kind, 0, c.title, c.url, c.blurb ?? "", c.source);
    return { added: plain.length, via: "top items (no AI)" };
  } finally { building = false; }
}


/**
 * Fresh ideas: original things to build, write or try, made by combining at least two real
 * inputs (a trending item, someone's focus, their recent plans or blockers). Each one carries
 * `origin`, a plain note on how it came up, ending with links to what inspired it.
 */
export async function buildSparks(given?: Candidate[]): Promise<number> {
  if (!aiReady()) return 0;
  const day = dayKey(env.defaultTz);
  const ms = await members.all();
  if (!ms.length) return 0;
  const cands = (given ?? (await sources())).sort((a, b) => b.score - a.score).slice(0, 24);
  const people = await Promise.all(ms.map(async (m, i) => {
    const w = await weekSummary(m);
    return { key: `p${i + 1}`, name: m.name, focus: w.focus, recentPlans: w.plans.slice(-3), recentBlockers: w.blockers.slice(-3), weekTotals: w.weekTotals };
  }));
  const recent = (await FI().find({ kind: "spark", created_at: { $gte: new Date(Date.now() - 30 * 86_400_000).toISOString() } }, { projection: { title: 1 } }).toArray()).map(r => r.title);
  const { data } = await askJson<{ ideas: { for: string; type: string; title: string; pitch: string; first_step: string; how: string; inspired_by: number[] }[] }>({
    system: "You are a creative partner for a small team of developers who are job hunting and building portfolios. You come up with original, specific ideas, never generic advice, and you're open about how you got to each one. Answer with JSON only.",
    prompt: `People:\n${JSON.stringify(people)}\n\nWhat's moving this week (numbered):\n${cands.map((c, i) => `${i}. [${c.source}] ${c.title}${c.blurb ? ` — ${c.blurb}` : ""}`).join("\n")}\n\n` +
      (recent.length ? `Don't repeat these recent ideas: ${JSON.stringify(recent)}\n\n` : "") +
      `Come up with 3 fresh ideas, at least one for each person. Each idea must combine at least two concrete inputs: an item from the list, a person's focus, their recent plans or blockers, or a gap you notice between them. Mix the types:\n` +
      `- "build": a small portfolio project (1–2 weeks) that would impress the kind of employer they want\n- "write": a post or talk angle only they could write, from what they're doing\n- "try": an experiment, outreach play or habit to test this week\n\n` +
      `For each give: "for" (a person's key or "both"), "type", "title" (short, specific), "pitch" (2–3 sentences: what it is and why it helps them get hired), ` +
      `"first_step" (one thing to do today, under 20 words), "how" (2–3 plain sentences on how you came up with it: name the exact inputs you combined and the leap that connects them), ` +
      `"inspired_by" (the list numbers you used, may be empty). Return {"ideas":[...]}.`,
    temperature: 0.95,
  });
  const keyOf = new Map(ms.map((m, i) => [`p${i + 1}`, m.id]));
  let added = 0;
  for (const idea of (data.ideas ?? []).slice(0, 4)) {
    if (!idea.title || !idea.pitch) continue;
    const used = (Array.isArray(idea.inspired_by) ? idea.inspired_by : []).map(n => cands[n]).filter(Boolean);
    const type = ["build", "write", "try"].includes(idea.type) ? idea.type : "build";
    const origin = [String(idea.how ?? "").trim(), ...used.map(c => `↳ ${c.title} (${c.source}) ${c.url}`)].filter(Boolean).join("\n");
    await insert(day, "spark", keyOf.get(idea.for) ?? 0, idea.title, "", `${idea.pitch}${idea.first_step ? `\n\nFirst step: ${idea.first_step}` : ""}`, type, origin);
    added++;
  }
  return added;
}

async function weekSummary(m: Member) {
  const keys = lastDays(m.tz, 7);
  const ds = await days.since(m.id, keys[0]);
  const totals = Object.fromEntries(COUNT_KEYS.map(k => [k, ds.reduce((s, d) => s + d[k], 0)]));
  const status = await leadStatus.all();
  const applied = Object.values(status).filter(s => s[m.id] === "applied").length;
  const open = (await todos.openFor(m.id)).filter(t => t.owner === m.id).length;
  return {
    focus: m.focus || "(not set)",
    dailyGoals: goalsOf(m),
    weekTotals: totals,
    daysClockedIn: ds.filter(d => d.in_at).length,
    daysAllGoalsHit: ds.filter(d => hitAll(m, d)).length,
    leadsAppliedTotal: applied,
    openTodos: open,
    plans: ds.map(d => d.plan).filter(Boolean).slice(-5).map(s => s.slice(0, 200)),
    blockers: ds.map(d => d.blocker).filter(Boolean).slice(-5).map(s => s.slice(0, 200)),
  };
}

/** Sunday: a "what to improve" note and two project ideas per person. */
export async function buildWeekly(): Promise<{ added: number; via: string }> {
  if (!aiReady()) return { added: 0, via: "no AI key" };
  const day = dayKey(env.defaultTz);
  const ms = await members.all();
  if (!ms.length) return { added: 0, via: "no members" };
  const people = await Promise.all(ms.map(async (m, i) => ({ key: `p${i + 1}`, name: m.name, ...(await weekSummary(m)) })));
  const { data, via } = await askJson<{ notes: { for: string; title: string; points: string[] }[]; ideas: { for: string; title: string; pitch: string; how?: string }[] }>({
    system: "You are a frank, practical career coach for developers job hunting together. You base advice on the numbers and notes given, not on generic tips. You answer with JSON only.",
    prompt: `This week, per person:\n${JSON.stringify(people, null, 1)}\n\n` +
      `1. "notes": for each person, a short title and 3 specific points on what to change next week. Point at their own numbers (e.g. lots of applications but no outreach → shift effort). If they did well, say what to keep.\n` +
      `2. "ideas": for each person, 2 portfolio project ideas that fit their focus, can be built in 1–2 weeks, and show skills employers ask for. "pitch" is 2–3 sentences: what it is, why it helps them get hired, the first step. "how" is 1–2 sentences on what in their week and focus led you to it.\n` +
      `Use the person's key in "for". Return {"notes":[...],"ideas":[...]}.`,
  });
  const keyOf = new Map(ms.map((m, i) => [`p${i + 1}`, m.id]));
  let added = 0;
  for (const n of data.notes ?? []) {
    const id = keyOf.get(n.for); if (!id) continue;
    await insert(day, "improve", id, n.title || "This week", "", (n.points ?? []).map(p => `• ${p}`).join("\n"), "Weekly note"); added++;
  }
  for (const idea of data.ideas ?? []) {
    const id = keyOf.get(idea.for); if (!id) continue;
    await insert(day, "idea", id, idea.title, "", idea.pitch ?? "", "Project idea", String(idea.how ?? "")); added++;
  }
  return { added, via };
}

export const feedSources = sources;

export const feed = {
  list: (limit = 80) => FI().find({}, NO_ID).sort({ id: -1 }).limit(limit).toArray() as Promise<FeedItem[]>,
  today: () => FI().find({ day: dayKey(env.defaultTz) }, NO_ID).sort({ id: 1 }).toArray() as Promise<FeedItem[]>,
  get: async (id: number) => (Number.isFinite(id) ? ((await FI().findOne({ _id: id }, NO_ID)) as FeedItem | null) ?? undefined : undefined),
  async saves(): Promise<Record<number, number[]>> {
    const out: Record<number, number[]> = {};
    for (const r of await FS().find({}).toArray()) (out[r.item] ??= []).push(r.member);
    return out;
  },
  async toggleSave(item: number, member: number) {
    const _id = `${item}:${member}`;
    if (await FS().findOne({ _id })) await FS().deleteOne({ _id });
    else await FS().updateOne({ _id }, { $set: { item, member } }, { upsert: true });
  },
};
