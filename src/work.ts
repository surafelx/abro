// "Do" things and show them: work items (projects, posts, skills) that can go to the
// portfolio and the resume, writing drafts for other platforms, the resume itself, and
// each person's link to their portfolio's API (docs/PORTFOLIO_API.md).
import crypto from "node:crypto";
import { env } from "./env";
import { NO_ID, col, nextId } from "./db";
import { kv } from "./store";

const now = () => new Date().toISOString();

export type WorkKind = "project" | "post" | "skill";
export type Links = { live?: string; code?: string; post?: string };
export type Work = {
  id: number; member: number; kind: WorkKind; title: string; summary: string; details: string; stack: string;
  links: string; status: "doing" | "done"; feed_item: number | null; portfolio_state: "none" | "draft" | "live";
  portfolio_url: string; in_resume: boolean; created_at: string; updated_at: string;
};
export type Draft = { id: number; member: number; work: number | null; feed_item: number | null; platform: string; body: string; created_at: string; status: "draft" | "posted"; posted_url: string; posted_at: string | null };

type WorkDoc = Work & { _id: number };
const WK = () => col<WorkDoc>("works");
const WORK_FIELDS = ["kind", "title", "summary", "details", "stack", "status", "portfolio_state", "portfolio_url", "in_resume", "links"];

export const works = {
  list: (member: number) => WK().find({ member }, NO_ID).sort({ status: 1, id: -1 }).toArray() as Promise<Work[]>,
  all: () => WK().find({}, NO_ID).sort({ id: -1 }).limit(200).toArray() as Promise<Work[]>,
  get: async (id: number) => (Number.isFinite(id) ? ((await WK().findOne({ _id: id }, NO_ID)) as Work | null) ?? undefined : undefined),
  async add(member: number, w: { kind: WorkKind; title: string; summary?: string; details?: string; stack?: string; links?: Links; feedItem?: number | null; status?: "doing" | "done" }) {
    const id = await nextId("works"), t = now();
    await WK().insertOne({
      _id: id, id, member, kind: w.kind, title: w.title.slice(0, 160), summary: (w.summary ?? "").slice(0, 400), details: (w.details ?? "").slice(0, 4000),
      stack: (w.stack ?? "").slice(0, 300), links: JSON.stringify(w.links ?? {}), status: w.status ?? "doing", feed_item: w.feedItem ?? null,
      portfolio_state: "none", portfolio_url: "", in_resume: false, created_at: t, updated_at: t,
    });
    return id;
  },
  async update(id: number, patch: Partial<Pick<Work, "kind" | "title" | "summary" | "details" | "stack" | "status" | "portfolio_state" | "portfolio_url" | "in_resume">> & { links?: Links }) {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && WORK_FIELDS.includes(k)) set[k] = k === "links" ? JSON.stringify(v) : v;
    if (!Object.keys(set).length) return;
    await WK().updateOne({ _id: id }, { $set: { ...set, updated_at: now() } });
  },
  remove: (id: number) => WK().deleteOne({ _id: id }),
};

export const linksOf = (w: Work): Links => { try { return JSON.parse(w.links) as Links; } catch { return {}; } };
export const slugOf = (w: Work) => `abro-${w.id}-${w.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;

type DraftDoc = Draft & { _id: number };
const DR = () => col<DraftDoc>("drafts");

export const drafts = {
  list: (member: number) => DR().find({ member }, NO_ID).sort({ id: -1 }).limit(40).toArray() as Promise<Draft[]>,
  get: async (id: number) => ((await DR().findOne({ _id: id }, NO_ID)) as Draft | null) ?? undefined,
  async add(member: number, d: { work?: number | null; feedItem?: number | null; platform: string; body: string }) {
    const id = await nextId("drafts");
    await DR().insertOne({ _id: id, id, member, work: d.work ?? null, feed_item: d.feedItem ?? null, platform: d.platform, body: d.body.slice(0, 6000), created_at: now(), status: "draft", posted_url: "", posted_at: null });
  },
  remove: (id: number) => DR().deleteOne({ _id: id }),
  setBody: (id: number, body: string) => DR().updateOne({ _id: id }, { $set: { body: body.slice(0, 6000) } }),
  markPosted: (id: number, url: string) => DR().updateOne({ _id: id }, { $set: { status: "posted", posted_url: url.slice(0, 600), posted_at: now() } }),
  unmarkPosted: (id: number) => DR().updateOne({ _id: id }, { $set: { status: "draft", posted_url: "", posted_at: null } }),
  /** Posts marked posted since `sinceIso` (anyone, newest first). */
  postedSince: (sinceIso: string) => DR().find({ status: "posted", posted_at: { $gte: sinceIso } }, NO_ID).sort({ posted_at: -1 }).toArray() as Promise<Draft[]>,
  countPosted: (member: number, sinceIso: string) => DR().countDocuments({ member, status: "posted", posted_at: { $gte: sinceIso } }),
};

// ---- Brand: post ideas and the profile check, kept per person -------------------
export type PostIdea = { hook: string; angle: string; platform: string; from: string };
export type ProfileCheck = { xBio: string; linkedinHeadline: string; linkedinAbout: string; pinnedPost: string; tips: string[]; at: string };
export const brand = {
  async get(member: number): Promise<{ ideas: PostIdea[]; check: ProfileCheck | null }> {
    const v = await kv.json<{ ideas?: PostIdea[]; check?: ProfileCheck | null }>(`brand:${member}`, {});
    return { ideas: v.ideas ?? [], check: v.check ?? null };
  },
  async set(member: number, patch: Partial<{ ideas: PostIdea[]; check: ProfileCheck | null }>) {
    const cur = await brand.get(member);
    await kv.set(`brand:${member}`, JSON.stringify({ ...cur, ...patch }));
  },
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

const PR = () => col<{ _id: number; data: Profile; updated_at: string }>("profiles");
export const profiles = {
  async get(member: number): Promise<Profile> {
    const r = await PR().findOne({ _id: member });
    return { ...emptyProfile(), ...(r?.data ?? {}) };
  },
  set: (member: number, p: Profile) => PR().updateOne({ _id: member }, { $set: { data: p, updated_at: now() } }, { upsert: true }),
};

type ResumeDoc = { _id: number; data: Resume; target: string; generated_at: string; published_at: string | null };
const RS = () => col<ResumeDoc>("resumes");
export const resumes = {
  async get(member: number): Promise<Omit<ResumeDoc, "_id"> | null> {
    return (await RS().findOne({ _id: member }, NO_ID)) as Omit<ResumeDoc, "_id"> | null;
  },
  set: (member: number, data: Resume, target: string) => RS().updateOne({ _id: member }, { $set: { data, target: target.slice(0, 200), generated_at: now() }, $setOnInsert: { published_at: null } }, { upsert: true }),
  markPublished: (member: number) => RS().updateOne({ _id: member }, { $set: { published_at: now() } }),
};

// ---- Portfolio link (key encrypted at rest) --------------------------------------

function cryptoKey() {
  if (!env.encryptionKey) throw new Error("Set ENCRYPTION_KEY on the server before linking a portfolio.");
  return crypto.createHash("sha256").update(env.encryptionKey).digest();
}
export function seal(text: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
}
export function open(sealed: string) {
  const [iv, tag, enc] = sealed.split(".").map(s => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", cryptoKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const PL = () => col<{ _id: number; url: string; key_enc: string }>("portfolio_links");
export const portfolioLinks = {
  async get(member: number): Promise<{ url: string; key: string } | null> {
    const r = await PL().findOne({ _id: member });
    if (!r) return null;
    try { return { url: r.url, key: open(r.key_enc) }; } catch { return null; }
  },
  async urlOf(member: number) { return (await PL().findOne({ _id: member }))?.url ?? null; },
  set: (member: number, url: string, key: string) => PL().updateOne({ _id: member }, { $set: { url: url.replace(/\/+$/, ""), key_enc: seal(key) } }, { upsert: true }),
  remove: (member: number) => PL().deleteOne({ _id: member }),
};
