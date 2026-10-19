// What you can do with things you learn, try and build. Used by the Mini App API and the bot.
import crypto from "node:crypto";
import { env } from "./env";
import { Member, todos } from "./store";
import { feed } from "./feed";
import { aiReady } from "./ai";
import { announce, esc, sendFile } from "./notify";
import { Platform, PLATFORMS, checkProfile, draftFromIdea, draftPosts, polishForPortfolio, postIdeas, writeResume } from "./writer";
import { Resume, WorkKind, brand, drafts, profiles, resumes, works } from "./work";
import { days } from "./store";
import { lastDays } from "./time";
import { portfolio } from "./portfolio";
import { resumeDocx, resumePdf } from "./resumeDoc";

class UserError extends Error {}
export { UserError };
const need = <T>(v: T | undefined | null, msg: string): T => { if (v == null) throw new UserError(msg); return v; };

async function ownWork(m: Member, id: number) {
  const w = need(await works.get(id), "That item is gone.");
  if (w.member !== m.id) throw new UserError("That belongs to a teammate.");
  return w;
}

/** "Do" on a feed item: make it a todo, start it as a project, or write about it. */
export async function doFromFeed(m: Member, itemId: number, action: "todo" | "project" | "write") {
  const item = need(await feed.get(itemId), "That feed item is gone.");
  if (action === "todo") {
    const verb = item.kind === "learn" ? "Learn" : item.kind === "try" ? "Try" : item.kind === "idea" ? "Build" : "Read";
    await todos.add(m.id, `${verb}: ${item.title}${item.url ? ` (${item.url})` : ""}`.slice(0, 300), m.id);
    return { message: "Added to your todos." };
  }
  if (action === "project") {
    const kind: WorkKind = item.kind === "learn" ? "skill" : "project";
    const id = await works.add(m.id, { kind, title: item.title, summary: item.body.split("\n")[0].slice(0, 400), details: item.url ? `Started from: ${item.url}` : "", feedItem: item.id });
    return { message: kind === "skill" ? "Added to your work as a skill you're learning." : "Started as a project in your work.", work: id };
  }
  await writeAbout(m, { itemId }, ["linkedin", "x", "devto"]);
  return { message: "Drafted posts. They're under You → Brand." };
}

export async function writeAbout(m: Member, src: { workId?: number; itemId?: number }, platforms: Platform[]) {
  if (!aiReady()) throw new UserError("Writing drafts needs an AI key on the server (GEMINI_API_KEY or OPENROUTER_API_KEY).");
  const work = src.workId ? await ownWork(m, src.workId) : undefined;
  const item = src.itemId ? need(await feed.get(src.itemId), "That feed item is gone.") : undefined;
  if (!work && !item) throw new UserError("Nothing to write about.");
  const posts = await draftPosts(m, { work, item }, platforms.filter(p => p in PLATFORMS));
  for (const p of posts) await drafts.add(m.id, { work: work?.id, feedItem: item?.id, platform: p.platform, body: p.body });
  return posts.length;
}

export async function addWork(m: Member, w: { kind: WorkKind; title: string; summary?: string; details?: string; stack?: string; links?: { live?: string; code?: string; post?: string } }) {
  if (!w.title.trim()) throw new UserError("Give it a title.");
  return works.add(m.id, { ...w, title: w.title.trim() });
}

export async function updateWork(m: Member, id: number, patch: Parameters<typeof works.update>[1]) {
  const w = await ownWork(m, id);
  await works.update(id, patch);
  // Keep a portfolio draft in step with edits (published entries change only on Publish).
  if (w.portfolio_state === "draft" && (patch.title || patch.summary || patch.details || patch.stack || patch.links)) {
    await portfolio.putDraft(m.id, (await works.get(id))!).catch(() => {});
  }
}

export async function finishWork(m: Member, id: number, done: boolean) {
  const w = await ownWork(m, id);
  await works.update(id, { status: done ? "done" : "doing" });
  if (done && w.status !== "done") await announce(`✅ <b>${esc(m.name)}</b> finished: ${esc(w.title)}`, { from: m.id });
}

/** Send to the portfolio as a hidden draft (AI tidies the write-up first when available). */
export async function toPortfolio(m: Member, id: number) {
  let w = await ownWork(m, id);
  if (aiReady() && w.portfolio_state === "none") {
    const polished = await polishForPortfolio(m, w).catch(() => null);
    if (polished) { await works.update(id, polished); w = (await works.get(id))!; }
  }
  const r = await portfolio.putDraft(m.id, w);
  await works.update(id, { portfolio_state: w.portfolio_state === "live" ? "live" : "draft", portfolio_url: r.url ?? w.portfolio_url });
  return { message: "Sent to your portfolio as a draft. Check the write-up, then Publish." };
}

export async function setPublished(m: Member, id: number, live: boolean) {
  const w = await ownWork(m, id);
  if (w.portfolio_state === "none") await portfolio.putDraft(m.id, w);
  const r = await portfolio.setVisible(m.id, w, live);
  await works.update(id, { portfolio_state: live ? "live" : "draft", portfolio_url: r.url ?? w.portfolio_url });
  if (live) await announce(`🚀 <b>${esc(m.name)}</b> published on their portfolio: ${esc(w.title)}${r.url ? `\n${esc(r.url)}` : ""}`, { from: m.id });
}

export async function removeFromPortfolio(m: Member, id: number) {
  const w = await ownWork(m, id);
  await portfolio.remove(m.id, w).catch(e => { if (!/404/.test(String(e))) throw e; });
  await works.update(id, { portfolio_state: "none", portfolio_url: "" });
}

export async function deleteWork(m: Member, id: number) {
  const w = await ownWork(m, id);
  if (w.portfolio_state !== "none") await portfolio.remove(m.id, w).catch(() => {});
  await works.remove(id);
}

// ---- Brand ------------------------------------------------------------------------

const weekStart = () => new Date(Date.now() - 7 * 86_400_000).toISOString();

export async function brandIdeas(m: Member) {
  if (!aiReady()) throw new UserError("Post ideas need an AI key on the server (GEMINI_API_KEY or OPENROUTER_API_KEY).");
  const keys = lastDays(m.tz, 7);
  const ds = await days.since(m.id, keys[0]);
  const ws = await works.list(m.id);
  const recentPosts = (await drafts.list(m.id)).filter(d => d.status === "posted").slice(0, 8).map(d => d.body.split("\n")[0].slice(0, 120));
  const ideas = await postIdeas(m, {
    plans: ds.map(d => d.plan).filter(Boolean).slice(-5), done: ds.map(d => d.done).filter(Boolean).slice(-5), blockers: ds.map(d => d.blocker).filter(Boolean).slice(-5),
    works: ws.slice(0, 8).map(w => ({ title: w.title, status: w.status, summary: w.summary })), recentPosts,
  });
  if (!ideas.length) throw new UserError("No ideas came back. Log a little more of your week (plan, done, work) and try again.");
  await brand.set(m.id, { ideas });
  return ideas.length;
}

export async function draftIdea(m: Member, index: number, platform: Platform) {
  if (!aiReady()) throw new UserError("Drafting needs an AI key on the server.");
  const { ideas } = await brand.get(m.id);
  const idea = need(ideas[index], "That idea is gone. Make new ones.");
  const body = await draftFromIdea(m, idea, platform);
  if (!body) throw new UserError("The draft came back empty. Try again.");
  await drafts.add(m.id, { platform, body });
}

export async function runProfileCheck(m: Member) {
  if (!aiReady()) throw new UserError("The profile check needs an AI key on the server.");
  const check = await checkProfile(m, await profiles.get(m.id), await works.list(m.id));
  await brand.set(m.id, { check });
}

/** Mark a draft as posted; the team gets the link so they can boost it early. */
export async function markPosted(m: Member, id: number, url: string) {
  const d = need(await drafts.get(id), "That draft is gone.");
  if (d.member !== m.id) throw new UserError("That draft belongs to a teammate.");
  await drafts.markPosted(id, url);
  const n = (await drafts.postedSince(weekStart())).filter(p => p.member === m.id).length;
  const where = PLATFORMS[d.platform as Platform] ?? d.platform;
  await announce(`📣 <b>${esc(m.name)}</b> posted on ${esc(where)} (${n}/${m.goal_posts} this week).${url ? `\n${esc(url)}\nGive it a like or a reply while it's fresh.` : ""}`, { from: m.id });
}

export async function postsThisWeek(member: number) {
  return (await drafts.postedSince(weekStart())).filter(p => p.member === member).length;
}

// ---- Resume -----------------------------------------------------------------------

export async function importProfile(m: Member) {
  const p = await portfolio.profile(m.id);
  await profiles.set(m.id, { ...(await profiles.get(m.id)), ...p });
}

export async function generateResume(m: Member, target: string) {
  if (!aiReady()) throw new UserError("Writing the resume needs an AI key on the server (GEMINI_API_KEY or OPENROUTER_API_KEY).");
  const profile = await profiles.get(m.id);
  const picked = (await works.list(m.id)).filter(w => w.in_resume);
  if (!profile.name && !profile.experience.length && !picked.length) throw new UserError("Add your details under Resume → Profile (or import them from your portfolio), and mark some work for the resume first.");
  const data = await writeResume(m, { ...profile, name: profile.name || m.name }, picked, target);
  await resumes.set(m.id, data, target);
  return data;
}

export async function resumeFiles(m: Member): Promise<{ data: Resume; pdf: Buffer; docx: Buffer; base: string }> {
  const r = need(await resumes.get(m.id), "Generate your resume first.");
  const base = `${(r.data.name || m.name).replace(/[^A-Za-z0-9]+/g, "_")}_Resume`;
  const [pdf, docx] = await Promise.all([resumePdf(r.data), resumeDocx(r.data)]);
  return { data: r.data, pdf, docx, base };
}

export async function sendResume(m: Member) {
  const f = await resumeFiles(m);
  await sendFile(m.id, f.pdf, `${f.base}.pdf`, "Your resume (PDF)");
  await sendFile(m.id, f.docx, `${f.base}.docx`, "Same resume as Word, if you want to edit it by hand");
}

export async function publishResume(m: Member) {
  const f = await resumeFiles(m);
  const r = await portfolio.putResume(m.id, f.pdf, f.docx);
  await resumes.markPublished(m.id);
  return r;
}

// Short-lived signed links so the Mini App can download files.
const signKey = () => crypto.createHash("sha256").update(`abro-files:${env.encryptionKey || env.token || "dev"}`).digest();
export function signedFileUrl(member: number, ext: "pdf" | "docx") {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = crypto.createHmac("sha256", signKey()).update(`${member}.${ext}.${exp}`).digest("hex").slice(0, 32);
  return `/files/resume/${member}.${ext}?exp=${exp}&sig=${sig}`;
}
export function checkFileSig(member: number, ext: string, exp: number, sig: string) {
  if (!(exp > Date.now() / 1000)) return false;
  const want = crypto.createHmac("sha256", signKey()).update(`${member}.${ext}.${exp}`).digest("hex").slice(0, 32);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
