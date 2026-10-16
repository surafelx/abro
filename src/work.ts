// "Do" things and show them: work items (projects, posts, skills) that can go to the
// portfolio and the resume, writing drafts for other platforms, the resume itself, and
// each person's link to their portfolio's API (docs/PORTFOLIO_API.md).
import crypto from "node:crypto";
import { env } from "./env";
import { one, q } from "./db";

const now = () => new Date().toISOString();

export type WorkKind = "project" | "post" | "skill";
export type Links = { live?: string; code?: string; post?: string };
export type Work = {
  id: number; member: number; kind: WorkKind; title: string; summary: string; details: string; stack: string;
  links: string; status: "doing" | "done"; feed_item: number | null; portfolio_state: "none" | "draft" | "live";
  portfolio_url: string; in_resume: boolean; created_at: string; updated_at: string;
};
export type Draft = { id: number; member: number; work: number | null; feed_item: number | null; platform: string; body: string; created_at: string };

export const works = {
  list: (member: number) => q<Work>("SELECT * FROM works WHERE member = $1 ORDER BY status = 'done', id DESC", [member]),
  all: () => q<Work>("SELECT * FROM works ORDER BY id DESC LIMIT 200"),
  get: (id: number) => (Number.isFinite(id) ? one<Work>("SELECT * FROM works WHERE id = $1", [id]) : Promise.resolve(undefined)),
  async add(member: number, w: { kind: WorkKind; title: string; summary?: string; details?: string; stack?: string; links?: Links; feedItem?: number | null; status?: "doing" | "done" }) {
    const r = await one<{ id: number }>(
      "INSERT INTO works (member, kind, title, summary, details, stack, links, status, feed_item, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id",
      [member, w.kind, w.title.slice(0, 160), (w.summary ?? "").slice(0, 400), (w.details ?? "").slice(0, 4000), (w.stack ?? "").slice(0, 300), JSON.stringify(w.links ?? {}), w.status ?? "doing", w.feedItem ?? null, now()]);
    return r!.id;
  },
  async update(id: number, patch: Partial<Pick<Work, "kind" | "title" | "summary" | "details" | "stack" | "status" | "portfolio_state" | "portfolio_url" | "in_resume">> & { links?: Links }) {
    const sets: string[] = [], vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (!["kind", "title", "summary", "details", "stack", "status", "portfolio_state", "portfolio_url", "in_resume", "links"].includes(k)) continue;
      vals.push(k === "links" ? JSON.stringify(v) : v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return;
    vals.push(now(), id);
    await q(`UPDATE works SET ${sets.join(", ")}, updated_at = $${vals.length - 1} WHERE id = $${vals.length}`, vals);
  },
  remove: (id: number) => q("DELETE FROM works WHERE id = $1", [id]),
};

export const linksOf = (w: Work): Links => { try { return JSON.parse(w.links) as Links; } catch { return {}; } };
export const slugOf = (w: Work) => `abro-${w.id}-${w.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;

export const drafts = {
  list: (member: number) => q<Draft>("SELECT * FROM drafts WHERE member = $1 ORDER BY id DESC LIMIT 40", [member]),
  get: (id: number) => one<Draft>("SELECT * FROM drafts WHERE id = $1", [id]),
  async add(member: number, d: { work?: number | null; feedItem?: number | null; platform: string; body: string }) {
    await q("INSERT INTO drafts (member, work, feed_item, platform, body, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [member, d.work ?? null, d.feedItem ?? null, d.platform, d.body.slice(0, 6000), now()]);
  },
  remove: (id: number) => q("DELETE FROM drafts WHERE id = $1", [id]),
};

// ---- Resume data ---------------------------------------------------------------

export type Profile = {
  name: string; headline: string; location: string; email: string; website: string;
  links: { label: string; url: string }[];
  summary: string;
  experience: { title: string; org: string; when: string; summary?: string; bullets?: string[] }[];
  education: { title: string; org: string; when: string }[];
  skills: { group: string; items: string[] }[];
};
export const emptyProfile = (): Profile => ({ name: "", headline: "", location: "", email: "", website: "", links: [], summary: "", experience: [], education: [], skills: [] });

export type Resume = Profile & { projects: { title: string; when?: string; summary: string; bullets: string[]; stack: string; link?: string }[] };

export const profiles = {
  async get(member: number): Promise<Profile> {
    const r = await one<{ data: string }>("SELECT data FROM profiles WHERE member = $1", [member]);
    try { return { ...emptyProfile(), ...(r ? JSON.parse(r.data) : {}) }; } catch { return emptyProfile(); }
  },
  set: (member: number, p: Profile) => q("INSERT INTO profiles (member, data, updated_at) VALUES ($1,$2,$3) ON CONFLICT (member) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at", [member, JSON.stringify(p), now()]),
};

export const resumes = {
  async get(member: number): Promise<{ data: Resume; target: string; generated_at: string; published_at: string | null } | null> {
    const r = await one<{ data: string; target: string; generated_at: string; published_at: string | null }>("SELECT * FROM resumes WHERE member = $1", [member]);
    if (!r) return null;
    try { return { ...r, data: JSON.parse(r.data) as Resume }; } catch { return null; }
  },
  set: (member: number, data: Resume, target: string) => q("INSERT INTO resumes (member, data, target, generated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (member) DO UPDATE SET data = EXCLUDED.data, target = EXCLUDED.target, generated_at = EXCLUDED.generated_at", [member, JSON.stringify(data), target.slice(0, 200), now()]),
  markPublished: (member: number) => q("UPDATE resumes SET published_at = $1 WHERE member = $2", [now(), member]),
};

// ---- Portfolio link (key encrypted at rest) --------------------------------------

function cryptoKey() {
  if (!env.encryptionKey) throw new Error("Set ENCRYPTION_KEY on the server before linking a portfolio.");
  return crypto.createHash("sha256").update(env.encryptionKey).digest();
}
function seal(text: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
}
function open(sealed: string) {
  const [iv, tag, enc] = sealed.split(".").map(s => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", cryptoKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

export const portfolioLinks = {
  async get(member: number): Promise<{ url: string; key: string } | null> {
    const r = await one<{ url: string; key_enc: string }>("SELECT url, key_enc FROM portfolio_links WHERE member = $1", [member]);
    if (!r) return null;
    try { return { url: r.url, key: open(r.key_enc) }; } catch { return null; }
  },
  async urlOf(member: number) { return (await one<{ url: string }>("SELECT url FROM portfolio_links WHERE member = $1", [member]))?.url ?? null; },
  set: (member: number, url: string, key: string) => q("INSERT INTO portfolio_links (member, url, key_enc) VALUES ($1,$2,$3) ON CONFLICT (member) DO UPDATE SET url = EXCLUDED.url, key_enc = EXCLUDED.key_enc", [member, url.replace(/\/+$/, ""), seal(key)]),
  remove: (member: number) => q("DELETE FROM portfolio_links WHERE member = $1", [member]),
};
