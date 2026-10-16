import crypto from "node:crypto";
import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { env } from "./env";
import { COUNT_KEYS, CountKey, Member, TEXT_KEYS, TextKey, canTouchTodo, days, goalsOf, leadStatus, members, session, todos } from "./store";
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
        id: m.id, name: m.name, username: m.username, tz: m.tz, goals: goalsOf(m),
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

export function createServer() {
  const app = express();
  app.set("trust proxy", false);
  app.use(express.json({ limit: "32kb" }));
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

  app.use("/api", api);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}
