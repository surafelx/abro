import crypto from "node:crypto";
import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { env } from "./env";
import { COUNT_KEYS, CountKey, Member, TEXT_KEYS, TextKey, canTouchTodo, days, goalsOf, leads, members, session, todos } from "./store";
import { convertTime, dayKey, lastDays, validTz } from "./time";
import { addLead, addTodo, bump, clockIn, clockOut } from "./actions";
import { botUsername } from "./notify";

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

function auth(req: Request, res: Response, next: NextFunction) {
  const h = req.get("authorization") ?? "";
  let id: number | null = null;
  if (h.startsWith("tma ")) id = verifyInitData(h.slice(4), env.token)?.id ?? null;
  else if (env.devUserId && isLocal(req) && !req.get("x-forwarded-for")) id = env.devUserId;
  const m = id ? members.get(id) : undefined;
  if (!m) return void res.status(id ? 403 : 401).json({ error: id ? "You're not on the team yet. Message the bot to ask to join." : "Open the board from the Telegram bot." });
  (req as AReq).member = m;
  next();
}

const wrap = (fn: (req: AReq, res: Response) => unknown) => (req: Request, res: Response) =>
  Promise.resolve(fn(req as AReq, res)).catch(e => { console.error(e); res.status(500).json({ error: "Something went wrong on the server." }); });

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function state(me: Member) {
  const ms = members.all();
  const s = session.get();
  return {
    me: me.id,
    bot: botUsername(),
    members: ms.map(m => {
      const date = dayKey(m.tz);
      const week = lastDays(m.tz, 7);
      return {
        id: m.id, name: m.name, username: m.username, tz: m.tz, goals: goalsOf(m),
        date, today: days.get(m.id, date),
        week: week.map(d => ({ date: d, day: days.find(m.id, d) ?? null })),
      };
    }),
    todos: todos.board(),
    leads: leads.list(100),
    session: { ...s, tz: env.defaultTz, local: s.time ? convertTime(s.time, env.defaultTz, me.tz) : null },
  };
}

export function createServer() {
  const app = express();
  app.set("trust proxy", false);
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(path.resolve("public"), { extensions: ["html"] }));

  const api = express.Router();
  api.use(auth);
  api.get("/state", wrap((req, res) => res.json(state(req.member))));

  api.post("/day/count", wrap(async (req, res) => {
    const key = req.body?.key as CountKey; const delta = Number(req.body?.delta);
    if (!COUNT_KEYS.includes(key) || !Number.isFinite(delta) || Math.abs(delta) > 50) return res.status(400).json({ error: "Bad count." });
    await bump(req.member, key, delta);
    res.json(state(req.member));
  }));
  api.post("/day/text", wrap((req, res) => {
    const key = req.body?.key as TextKey;
    if (!TEXT_KEYS.includes(key)) return res.status(400).json({ error: "Bad field." });
    days.setText(req.member.id, dayKey(req.member.tz), key, str(req.body?.text, 2000));
    res.json({ ok: true });
  }));
  api.post("/day/clock", wrap(async (req, res) => {
    if (req.body?.action === "in") await clockIn(req.member, undefined);
    else if (req.body?.action === "out") await clockOut(req.member, undefined);
    else return res.status(400).json({ error: "Bad action." });
    res.json(state(req.member));
  }));

  api.post("/todos", wrap(async (req, res) => {
    const text = str(req.body?.text, 300);
    if (!text) return res.status(400).json({ error: "Write the todo first." });
    await addTodo(req.member, text, Boolean(req.body?.shared));
    res.json(state(req.member));
  }));
  api.post("/todos/:id/toggle", wrap((req, res) => {
    const t = todos.get(Number(req.params.id));
    if (!t || !canTouchTodo(t, req.member.id)) return res.status(403).json({ error: "That todo belongs to your partner." });
    todos.toggle(t.id, req.member.id);
    res.json(state(req.member));
  }));
  api.delete("/todos/:id", wrap((req, res) => {
    const t = todos.get(Number(req.params.id));
    if (!t || t.created_by !== req.member.id) return res.status(403).json({ error: "Only the person who added it can delete it." });
    todos.remove(t.id);
    res.json(state(req.member));
  }));

  api.post("/leads", wrap(async (req, res) => {
    const title = str(req.body?.title, 160);
    if (!title) return res.status(400).json({ error: "Give the role a name." });
    await addLead(req.member, { title, company: str(req.body?.company, 100), url: str(req.body?.url, 600), note: str(req.body?.note, 400), forWho: Number(req.body?.forWho) || 0 });
    res.json(state(req.member));
  }));
  api.post("/leads/:id/status", wrap(async (req, res) => {
    const l = leads.get(Number(req.params.id));
    const s = req.body?.status;
    if (!l || !(s === "applied" || s === "skip" || s === null)) return res.status(400).json({ error: "Bad status." });
    const was = l.status[req.member.id];
    leads.setStatus(l.id, req.member.id, s);
    if (s === "applied" && was !== "applied") await bump(req.member, "apps", 1);
    res.json(state(req.member));
  }));
  api.delete("/leads/:id", wrap((req, res) => {
    const l = leads.get(Number(req.params.id));
    if (!l || l.by !== req.member.id) return res.status(403).json({ error: "Only the person who shared it can remove it." });
    leads.remove(l.id);
    res.json(state(req.member));
  }));

  api.post("/me", wrap((req, res) => {
    const g = req.body?.goals;
    if (g && typeof g === "object") members.setGoals(req.member.id, { apps: Number(g.apps), outreach: Number(g.outreach), commits: Number(g.commits) });
    const tz = str(req.body?.tz, 64);
    if (tz) { if (!validTz(tz)) return res.status(400).json({ error: "Unknown time zone." }); members.setTz(req.member.id, tz); }
    res.json(state(members.get(req.member.id)!));
  }));
  api.post("/session", wrap((req, res) => {
    const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const d = Array.isArray(req.body?.days) ? DAYS.filter(x => req.body.days.includes(x)) : [];
    const time = str(req.body?.time, 5);
    if (time && !/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ error: "Use 24-hour time like 20:00." });
    session.set({ days: d, time, link: str(req.body?.link, 300) });
    res.json(state(req.member));
  }));

  app.use("/api", api);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}
