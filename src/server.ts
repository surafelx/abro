import crypto from "node:crypto";
import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { Bot, webhookCallback } from "grammy";
import { env } from "./env";
import { COUNT_KEYS, CountKey, Member, TEXT_KEYS, TextKey, canTouchTodo, days, goalsOf, kv, leadStatus, members, session, todos } from "./store";
import { buildDaily, buildSparks, feed } from "./feed";
import { aiReady } from "./ai";
import { tick } from "./reminders";
import * as W from "./workActions";
import { portfolio } from "./portfolio";
import { Profile, brand, drafts, emptyProfile, portfolioLinks, profiles, resumes, works } from "./work";
import { convertTime, dayKey, lastDays, validTz } from "./time";
import { addTodo, bump, clockIn, clockOut, shareLead } from "./actions";
import { botUsername } from "./notify";
import { apleo, apleoReady } from "./apleo";

/** Check Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). */
export function verifyInitData(raw: string, token: string, maxAgeSec = 86_400): { id: number } | null {
  if (!raw || !token) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") ?? 0);
  if (!(age >= -60 && age <= maxAgeSec)) return null;
  try { const u = JSON.parse(p.get("user") ?? "null"); return u && typeof u.id === "number" ? { id: u.id } : null; } catch { return null; }
}

type AReq = Request & { member: Member };
const isLocal = (req: Request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

const wrap = (fn: (req: AReq, res: Response) => unknown) => (req: Request, res: Response) =>
  Promise.resolve(fn(req as AReq, res)).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: "Something went wrong on the server." }); });

async function auth(req: Request, res: Response, next: NextFunction) {
  try {
    const h = req.get("authorization") ?? "";
    let id: number | null = null;
    if (h.startsWith("tma ")) id = verifyInitData(h.slice(4), env.token)?.id ?? null;
    else if (env.devUserId && isLocal(req) && !req.get("x-forwarded-for")) id = env.devUserId;
    const m = id ? await members.get(id) : undefined;
    if (!m) return void res.status(id ? 403 : 401).json({ error: id ? "You're not on the team yet. Message the bot to ask to join." : "Open the board from the Telegram bot." });
    (req as AReq).member = m;
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: "Something went wrong on the server." }); }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function state(me: Member) {
  const ms = await members.all();
  const s = await session.get();
  let leads: unknown[] = [], leadsError: string | null = null;
  try {
    const [list, status] = await Promise.all([apleo.list(), leadStatus.all()]);
    leads = list.map(l => ({ ...l, status: status[l.id] ?? {} }));
  } catch (e) { leadsError = (e as Error).message; }
  return {
    me: me.id,
    bot: botUsername(),
    members: await Promise.all(ms.map(async m => {
      const date = dayKey(m.tz);
      const week = lastDays(m.tz, 7);
      const byDate = new Map((await days.since(m.id, week[0])).map(d => [d.date, d]));
      return {
        id: m.id, name: m.name, username: m.username, tz: m.tz, goals: goalsOf(m), focus: m.focus, goalPosts: m.goal_posts, postedThisWeek: await W.postsThisWeek(m.id),
        date, today: await days.get(m.id, date),
        week: week.map(d => ({ date: d, day: byDate.get(d) ?? null })),
      };
    })),
    todos: await todos.board(),
    leads, leadsError, apleo: apleoReady(),
    session: { ...s, tz: env.defaultTz, local: s.time ? convertTime(s.time, env.defaultTz, me.tz) : null },
  };
}
const fresh = async (req: AReq) => state((await members.get(req.member.id))!);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createServer(bot?: Bot<any> | null) {
  const app = express();
  app.set("trust proxy", false);
  app.use(express.json({ limit: "32kb" }));

  // Webhook mode (free hosts that sleep): Telegram POSTs updates here.
  if (bot && env.botMode === "webhook") app.post("/tg", webhookCallback(bot, "express", { secretToken: env.webhookSecret || undefined }));

  // Signed, short-lived resume downloads (links come from /api/resume/links).
  app.get("/files/resume/:file", async (req, res) => {
    const m = /^(\d+)\.(pdf|docx)$/.exec(req.params.file);
    if (!m || !W.checkFileSig(Number(m[1]), m[2], Number(req.query.exp), String(req.query.sig ?? ""))) return void res.status(403).send("This download link has expired. Open it again from Abro.");
    try {
      const member = await members.get(Number(m[1]));
      if (!member) return void res.status(404).send("Not found");
      const f = await W.resumeFiles(member);
      res.setHeader("content-type", m[2] === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("content-disposition", `attachment; filename="${f.base}.${m[2]}"`);
      res.send(m[2] === "pdf" ? f.pdf : f.docx);
    } catch (e) { res.status(400).send((e as Error).message); }
  });

  // A free scheduler calls this every few minutes so reminders and the feed run on hosts that sleep.
  app.get("/tick", (req, res) => {
    if (!env.cronKey || req.query.key !== env.cronKey) return void res.status(401).json({ error: "Bad key." });
    tick().then(() => res.json({ ok: true })).catch(e => { console.error(e); res.status(500).json({ error: "Tick failed." }); });
  });
  app.use(express.static(path.resolve("public"), { extensions: ["html"] }));

  const api = express.Router();
  api.use(auth);
  api.get("/state", wrap(async (req, res) => res.json(await state(req.member))));

  api.post("/day/count", wrap(async (req, res) => {
    const key = req.body?.key as CountKey; const delta = Number(req.body?.delta);
    if (!COUNT_KEYS.includes(key) || !Number.isFinite(delta) || Math.abs(delta) > 50) return res.status(400).json({ error: "Bad count." });
    await bump(req.member, key, delta);
    res.json(await fresh(req));
  }));
  api.post("/day/text", wrap(async (req, res) => {
    const key = req.body?.key as TextKey;
    if (!TEXT_KEYS.includes(key)) return res.status(400).json({ error: "Bad field." });
    await days.setText(req.member.id, dayKey(req.member.tz), key, str(req.body?.text, 2000));
    res.json({ ok: true });
  }));
  api.post("/day/clock", wrap(async (req, res) => {
    if (req.body?.action === "in") await clockIn(req.member, undefined);
    else if (req.body?.action === "out") await clockOut(req.member, undefined);
    else return res.status(400).json({ error: "Bad action." });
    res.json(await fresh(req));
  }));

  api.post("/todos", wrap(async (req, res) => {
    const text = str(req.body?.text, 300);
    if (!text) return res.status(400).json({ error: "Write the todo first." });
    await addTodo(req.member, text, Boolean(req.body?.shared));
    res.json(await fresh(req));
  }));
  api.post("/todos/:id/toggle", wrap(async (req, res) => {
    const t = await todos.get(Number(req.params.id));
    if (!t || !canTouchTodo(t, req.member.id)) return res.status(403).json({ error: "That todo belongs to your partner." });
    await todos.toggle(t.id, req.member.id);
    res.json(await fresh(req));
  }));
  api.delete("/todos/:id", wrap(async (req, res) => {
    const t = await todos.get(Number(req.params.id));
    if (!t || t.created_by !== req.member.id) return res.status(403).json({ error: "Only the person who added it can delete it." });
    await todos.remove(t.id);
    res.json(await fresh(req));
  }));

  api.post("/leads", wrap(async (req, res) => {
    const title = str(req.body?.title, 160);
    if (!title) return res.status(400).json({ error: "Give the role a name." });
    try {
      await shareLead(req.member, { title, company: str(req.body?.company, 100), url: str(req.body?.url, 600), note: str(req.body?.note, 400), forWho: Number(req.body?.forWho) || 0, openToEthiopia: req.body?.openToEthiopia !== false });
    } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    res.json(await fresh(req));
  }));
  api.post("/leads/:id/status", wrap(async (req, res) => {
    const id = String(req.params.id);
    const s = req.body?.status;
    if (!/^[a-f0-9]{24}$/.test(id) || !(s === "applied" || s === "skip" || s === null)) return res.status(400).json({ error: "Bad status." });
    const was = (await leadStatus.of(id))[req.member.id];
    await leadStatus.set(id, req.member.id, s);
    if (s === "applied" && was !== "applied") await bump(req.member, "apps", 1);
    res.json(await fresh(req));
  }));
  api.delete("/leads/:id", wrap(async (req, res) => {
    const l = await apleo.get(String(req.params.id)).catch(() => undefined);
    if (!l || l.by !== req.member.id) return res.status(403).json({ error: "Only the person who shared it can take it down." });
    try { await apleo.remove(l.id); } catch (e) { return res.status(502).json({ error: (e as Error).message }); }
    await leadStatus.forget(l.id);
    res.json(await fresh(req));
  }));

  api.post("/me", wrap(async (req, res) => {
    const g = req.body?.goals;
    if (g && typeof g === "object") await members.setGoals(req.member.id, { apps: Number(g.apps), outreach: Number(g.outreach), commits: Number(g.commits) });
    if (typeof req.body?.focus === "string") await members.setFocus(req.member.id, str(req.body.focus, 500));
    if (req.body?.goalPosts !== undefined && Number.isFinite(Number(req.body.goalPosts))) await members.setPostGoal(req.member.id, Number(req.body.goalPosts));
    const tz = str(req.body?.tz, 64);
    if (tz) { if (!validTz(tz)) return res.status(400).json({ error: "Unknown time zone." }); await members.setTz(req.member.id, tz); }
    res.json(await fresh(req));
  }));
  api.post("/session", wrap(async (req, res) => {
    const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const d = Array.isArray(req.body?.days) ? DAYS.filter(x => req.body.days.includes(x)) : [];
    const time = str(req.body?.time, 5);
    if (time && !/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ error: "Use 24-hour time like 20:00." });
    await session.set({ days: d, time, link: str(req.body?.link, 300) });
    res.json(await fresh(req));
  }));

  api.get("/feed", wrap(async (_req, res) => res.json({ items: await feed.list(80), saves: await feed.saves(), ai: aiReady() })));
  api.post("/feed/:id/save", wrap(async (req, res) => {
    const item = await feed.get(Number(req.params.id));
    if (!item) return res.status(404).json({ error: "That item is gone." });
    await feed.toggleSave(item.id, req.member.id);
    res.json({ items: await feed.list(80), saves: await feed.saves(), ai: aiReady() });
  }));
  api.post("/feed/sparks", wrap(async (_req, res) => {
    if (!aiReady()) return res.status(400).json({ error: "Fresh ideas need an AI key on the server (GEMINI_API_KEY or OPENROUTER_API_KEY)." });
    const last = Number((await kv.get("feed:lastSparks")) ?? 0);
    if (Date.now() - last < 30 * 60_000) return res.status(429).json({ error: "New ideas were made in the last 30 minutes. Try again later." });
    await kv.set("feed:lastSparks", String(Date.now()));
    const added = await buildSparks().catch(e => { console.error(e); return 0; });
    res.json({ added, items: await feed.list(80), saves: await feed.saves(), ai: aiReady() });
  }));
  api.post("/feed/refresh", wrap(async (_req, res) => {
    const last = Number((await kv.get("feed:lastRefresh")) ?? 0);
    if (Date.now() - last < 60 * 60_000) return res.status(429).json({ error: "The feed was refreshed in the last hour. Try again later." });
    await kv.set("feed:lastRefresh", String(Date.now()));
    const r = await buildDaily();
    res.json({ added: r.added, items: await feed.list(80), saves: await feed.saves(), ai: aiReady() });
  }));

  // ---- Do, work, writing, portfolio, resume ----
  const act = (fn: (req: AReq, res: Response) => Promise<unknown>) => wrap(async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof TypeError || e instanceof ReferenceError) throw e;
      res.status(400).json({ error: (e as Error).message });
    }
  });
  const you = async (m: Member) => {
    const r = await resumes.get(m.id);
    return {
      works: await works.list(m.id),
      drafts: await drafts.list(m.id),
      profile: await profiles.get(m.id),
      resume: r ? { data: r.data, target: r.target, generatedAt: r.generated_at, publishedAt: r.published_at } : null,
      portfolio: { url: await portfolioLinks.urlOf(m.id) },
      ai: aiReady(),
      brand: {
        ...(await brand.get(m.id)),
        goal: m.goal_posts,
        postedThisWeek: await W.postsThisWeek(m.id),
        // What the partner posted lately, so you can boost it.
        partnerPosts: (await drafts.postedSince(new Date(Date.now() - 7 * 86_400_000).toISOString())).filter(d => d.member !== m.id).slice(0, 6)
          .map(d => ({ id: d.id, member: d.member, platform: d.platform, url: d.posted_url, at: d.posted_at, preview: d.body.split("\n")[0].slice(0, 140) })),
      },
    };
  };
  const id = (req: Request) => Number(req.params.id);
  const LINK = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v.trim()) ? v.trim().slice(0, 600) : "");
  const links = (v: unknown) => { const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>; return { live: LINK(o.live), code: LINK(o.code), post: LINK(o.post) }; };

  api.get("/you", act(async (req, res) => res.json(await you(req.member))));
  api.post("/feed/:id/do", act(async (req, res) => {
    const action = req.body?.action;
    if (!["todo", "project", "write"].includes(action)) return void res.status(400).json({ error: "Bad action." });
    const r = await W.doFromFeed(req.member, id(req), action);
    res.json({ ...r, you: await you(req.member) });
  }));
  api.post("/works", act(async (req, res) => {
    const kind = ["project", "post", "skill"].includes(req.body?.kind) ? req.body.kind : "project";
    await W.addWork(req.member, { kind, title: str(req.body?.title, 160), summary: str(req.body?.summary, 400), details: str(req.body?.details, 4000), stack: str(req.body?.stack, 300), links: links(req.body?.links) });
    res.json(await you(req.member));
  }));
  api.patch("/works/:id", act(async (req, res) => {
    const b = req.body ?? {};
    await W.updateWork(req.member, id(req), {
      title: b.title !== undefined ? str(b.title, 160) : undefined, summary: b.summary !== undefined ? str(b.summary, 400) : undefined,
      details: b.details !== undefined ? str(b.details, 4000) : undefined, stack: b.stack !== undefined ? str(b.stack, 300) : undefined,
      links: b.links !== undefined ? links(b.links) : undefined, in_resume: typeof b.in_resume === "boolean" ? b.in_resume : undefined,
      kind: ["project", "post", "skill"].includes(b.kind) ? b.kind : undefined,
    });
    res.json(await you(req.member));
  }));
  api.post("/works/:id/done", act(async (req, res) => { await W.finishWork(req.member, id(req), req.body?.done !== false); res.json(await you(req.member)); }));
  api.post("/works/:id/write", act(async (req, res) => {
    const platforms = (Array.isArray(req.body?.platforms) ? req.body.platforms : ["linkedin", "x", "devto"]).filter((p: string) => ["linkedin", "x", "devto"].includes(p));
    const n = await W.writeAbout(req.member, { workId: id(req) }, platforms);
    res.json({ message: `Drafted ${n} post${n === 1 ? "" : "s"}.`, you: await you(req.member) });
  }));
  api.post("/works/:id/portfolio", act(async (req, res) => { const r = await W.toPortfolio(req.member, id(req)); res.json({ ...r, you: await you(req.member) }); }));
  api.post("/works/:id/publish", act(async (req, res) => { await W.setPublished(req.member, id(req), req.body?.live !== false); res.json(await you(req.member)); }));
  api.delete("/works/:id/portfolio", act(async (req, res) => { await W.removeFromPortfolio(req.member, id(req)); res.json(await you(req.member)); }));
  api.delete("/works/:id", act(async (req, res) => { await W.deleteWork(req.member, id(req)); res.json(await you(req.member)); }));
  api.delete("/drafts/:id", act(async (req, res) => {
    const d = await drafts.get(id(req));
    if (!d || d.member !== req.member.id) return void res.status(404).json({ error: "That draft is gone." });
    await drafts.remove(d.id); res.json(await you(req.member));
  }));

  // ---- Brand ----
  api.post("/drafts", act(async (req, res) => {
    const platform = ["x", "linkedin", "devto"].includes(req.body?.platform) ? req.body.platform : "x";
    const body = str(req.body?.body, 6000);
    if (!body) return void res.status(400).json({ error: "Write something first." });
    await drafts.add(req.member.id, { platform, body });
    res.json(await you(req.member));
  }));
  api.patch("/drafts/:id", act(async (req, res) => {
    const d = await drafts.get(id(req));
    if (!d || d.member !== req.member.id) return void res.status(404).json({ error: "That draft is gone." });
    await drafts.setBody(d.id, str(req.body?.body, 6000)); res.json(await you(req.member));
  }));
  api.post("/drafts/:id/posted", act(async (req, res) => {
    if (req.body?.posted === false) {
      const d = await drafts.get(id(req));
      if (!d || d.member !== req.member.id) return void res.status(404).json({ error: "That draft is gone." });
      await drafts.unmarkPosted(d.id); return void res.json(await you(req.member));
    }
    await W.markPosted(req.member, id(req), LINK(req.body?.url));
    res.json({ message: "Marked posted. Your partner got the link.", you: await you(req.member) });
  }));
  api.post("/brand/ideas", act(async (req, res) => {
    const last = Number((await kv.get(`brand:lastIdeas:${req.member.id}`)) ?? 0);
    if (Date.now() - last < 10 * 60_000) return void res.status(429).json({ error: "You made ideas a few minutes ago. Try again in a bit." });
    await kv.set(`brand:lastIdeas:${req.member.id}`, String(Date.now()));
    const n = await W.brandIdeas(req.member);
    res.json({ message: `${n} post ideas from your week.`, you: await you(req.member) });
  }));
  api.post("/brand/ideas/:id/draft", act(async (req, res) => {
    const platform = ["x", "linkedin", "devto"].includes(req.body?.platform) ? req.body.platform : "x";
    await W.draftIdea(req.member, id(req), platform);
    res.json({ message: "Drafted. It's in your queue below.", you: await you(req.member) });
  }));
  api.post("/brand/check", act(async (req, res) => { await W.runProfileCheck(req.member); res.json({ message: "Profile check ready.", you: await you(req.member) }); }));

  api.put("/profile", act(async (req, res) => {
    const b = (req.body?.profile ?? {}) as Partial<Profile>;
    const arr = <T,>(v: unknown, max: number) => (Array.isArray(v) ? (v as T[]).slice(0, max) : []);
    const clean: Profile = {
      ...emptyProfile(),
      name: str(b.name, 100), headline: str(b.headline, 160), location: str(b.location, 100), email: str(b.email, 160), website: LINK(b.website),
      summary: str(b.summary, 1200),
      links: arr<{ label: string; url: string }>(b.links, 6).map(l => ({ label: str(l?.label, 40), url: LINK(l?.url) })).filter(l => l.url),
      experience: arr<Profile["experience"][number]>(b.experience, 12).map(e => ({ title: str(e?.title, 120), org: str(e?.org, 120), when: str(e?.when, 60), summary: str(e?.summary, 600), bullets: arr<string>(e?.bullets, 8).map(x => str(x, 300)).filter(Boolean) })).filter(e => e.title || e.org),
      education: arr<Profile["education"][number]>(b.education, 6).map(e => ({ title: str(e?.title, 120), org: str(e?.org, 120), when: str(e?.when, 60) })).filter(e => e.title || e.org),
      skills: arr<Profile["skills"][number]>(b.skills, 8).map(g => ({ group: str(g?.group, 60), items: arr<string>(g?.items, 30).map(x => str(x, 60)).filter(Boolean) })).filter(g => g.items.length),
    };
    await profiles.set(req.member.id, clean);
    res.json(await you(req.member));
  }));
  api.post("/profile/import", act(async (req, res) => { await W.importProfile(req.member); res.json(await you(req.member)); }));
  api.post("/resume/generate", act(async (req, res) => { await W.generateResume(req.member, str(req.body?.target, 200)); res.json(await you(req.member)); }));
  api.post("/resume/send", act(async (req, res) => { await W.sendResume(req.member); res.json({ message: "Sent to your chat with the bot." }); }));
  api.post("/resume/publish", act(async (req, res) => { const r = await W.publishResume(req.member); res.json({ message: "Your portfolio has the new resume.", ...r, you: await you(req.member) }); }));
  api.get("/resume/links", act(async (req, res) => {
    if (!(await resumes.get(req.member.id))) return void res.status(400).json({ error: "Generate your resume first." });
    const base = env.publicUrl || `${req.protocol}://${req.get("host")}`;
    res.json({ pdf: base + W.signedFileUrl(req.member.id, "pdf"), docx: base + W.signedFileUrl(req.member.id, "docx") });
  }));
  api.put("/portfolio", act(async (req, res) => {
    const url = LINK(req.body?.url), key = str(req.body?.key, 300);
    if (!url || !key) return void res.status(400).json({ error: "Give your portfolio API's address (https://…/api/abro) and its key." });
    try { await portfolio.test(url, key); }
    catch (e) { return void res.status(400).json({ error: `Not saved: ${(e as Error).message}` }); }
    await portfolioLinks.set(req.member.id, url, key);
    res.json({ message: "Portfolio linked and working.", you: await you(req.member) });
  }));
  api.delete("/portfolio", act(async (req, res) => { await portfolioLinks.remove(req.member.id); res.json(await you(req.member)); }));

  app.use("/api", api);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}
