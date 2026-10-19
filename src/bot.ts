import { Bot, Context, InlineKeyboard } from "grammy";
import { env } from "./env";
import { COUNT_LABEL, CountKey, Member, canTouchTodo, days, kv, leadStatus, members, profileOf, session, todos } from "./store";
import { dayKey, validTz } from "./time";
import { announce, boardReady, cardText, esc, todayText, weekText } from "./notify";
import { addTodo, bump, clockIn, clockOut, shareLead } from "./actions";
import { apleo, picks as apleoPicks, Pick, PickStatus } from "./apleo";
import { feed } from "./feed";
import { sendResume, addWork } from "./workActions";

const HELP = `<b>Abro</b> · አብሮ · together, on the clock

<b>Your day</b>
/in <i>plan</i> · clock in with today's plan
/out <i>what got done</i> · clock out
/plan <i>text</i> · /blocked <i>text</i>
/app · /reach · /commit · log one (or /app 3, /app -1)

<b>Todos</b>
/todo <i>text</i> · add one for you
/shared <i>text</i> · add one for the whole team
/todos · list them, tap to tick off
/done <i>number</i> · tick one off by number

<b>Your picks</b> (chosen for you each morning)
/picks · today's picks, tap Applied or Skip
/pipeline · roles you applied to: mark replies, interviews, offers

<b>Leads</b> (posted publicly on Apleo)
/lead <i>link role @ company | why it fits</i>
/leads · open leads

<b>Feed</b>
/feed · today's picks: news, things to learn and try, project ideas
/focus <i>text</i> · what you're working toward, so the feed fits you

<b>Show your work</b>
/built <i>what you made</i> · log it (then add it to your portfolio on the board)
/resume · get your latest resume as PDF and Word
Brand (posting goal, post ideas from your week, one-tap posting, profile check) is under You → Brand on the board.

<b>Team</b>
/today · both time cards
/week · the 7-day grid
/session · when we meet
/board · open the full board
/goals <i>apps outreach commits</i> · e.g. /goals 5 3 1
/tz <i>Area/City</i> · e.g. /tz Asia/Shanghai`;

type Ctx = Context & { member?: Member };
const arg = (ctx: Context) => String(ctx.match ?? "").trim();
const reply = (ctx: Context, text: string, keyboard?: InlineKeyboard) =>
  ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}) });
const src = (ctx: Context) => ({ sourceChat: ctx.chat?.id });

function boardKeyboard(ctx: Context) {
  if (!boardReady()) return undefined;
  if (ctx.chat?.type === "private") return new InlineKeyboard().webApp("Open the board", env.publicUrl);
  return new InlineKeyboard().url("Open the board", `https://t.me/${ctx.me.username}?start=board`);
}

async function todosView(m: Member) {
  const all = (await todos.board()).filter(t => !t.done_at);
  const mine = all.filter(t => t.owner === m.id), shared = all.filter(t => t.owner === 0);
  const others = (await members.all()).filter(x => x.id !== m.id);
  const line = (t: { id: number; text: string }) => `<code>#${t.id}</code> ${esc(t.text)}`;
  const parts = [`<b>Your todos</b>\n${mine.length ? mine.map(line).join("\n") : "<i>Nothing open.</i>"}`];
  if (shared.length) parts.push(`<b>Shared</b>\n${shared.map(line).join("\n")}`);
  for (const x of others) { const list = all.filter(t => t.owner === x.id); parts.push(`<b>${esc(x.name)}</b>\n${list.length ? list.map(line).join("\n") : "<i>Nothing open.</i>"}`); }
  const kb = new InlineKeyboard();
  for (const t of [...mine, ...shared].slice(0, 24)) kb.text(`✓ ${t.text.slice(0, 28)}`, `td:${t.id}`).row();
  return { text: parts.join("\n\n"), kb };
}

async function picksView(m: Member) {
  const slug = profileOf(m);
  if (!slug) return { text: "You don't have picks yet. Ask the admin to add your profile, then set its name on the board (Setup → My Apleo profile).", kb: new InlineKeyboard() };
  const all = await apleoPicks.list(slug, true);
  const open = all.filter(p => p.status === "new");
  if (!open.length) return { text: all.length ? "No open picks. You've handled everything from the last two weeks." : "No picks yet. They arrive after the morning run.", kb: new InlineKeyboard() };
  const latest = open[0].day;
  const shown = open.filter(p => p.day === latest).slice(0, 8);
  const kb = new InlineKeyboard();
  const line = (p: Pick, i: number) => {
    kb.text(`Applied ${i + 1}`, `pk:applied:${p.id}`).text(`Skip ${i + 1}`, `pk:skipped:${p.id}`).row();
    return `<b>${i + 1}. ${esc(p.title)}</b> · ${esc(p.company)}${p.verdict === "maybe" ? " <i>(maybe)</i>" : ""}\n${esc(p.why)}${p.redFlags?.length ? `\n⚠ ${esc(p.redFlags.join(" · "))}` : ""}\n<a href="${esc(p.applyUrl || p.url)}">Apply link</a>`;
  };
  return { text: `<b>Your picks · ${esc(latest)}</b>\n\n${shown.map(line).join("\n\n")}${open.length > shown.length ? `\n\n+${open.length - shown.length} more open on the board.` : ""}`, kb };
}

const NEXT: Record<string, [PickStatus, string][]> = {
  applied: [["replied", "Replied"], ["interview", "Interview"], ["rejected", "Rejected"]],
  replied: [["interview", "Interview"], ["rejected", "Rejected"]],
  interview: [["offer", "Offer 🎉"], ["rejected", "Rejected"]],
};
async function pipelineView(m: Member) {
  const slug = profileOf(m);
  if (!slug) return { text: "Set your Apleo profile on the board first (Setup → My Apleo profile).", kb: new InlineKeyboard() };
  const live = (await apleoPicks.list(slug, true)).filter(p => p.status in NEXT).slice(0, 10);
  if (!live.length) return { text: "Nothing in progress. When you apply to a pick, it shows up here so you can log replies and interviews.", kb: new InlineKeyboard() };
  const kb = new InlineKeyboard();
  const text = live.map((p, i) => {
    for (const [s, label] of NEXT[p.status]) kb.text(`${label} ${i + 1}`, `po:${s}:${p.id}`);
    kb.row();
    return `<b>${i + 1}. ${esc(p.title)}</b> · ${esc(p.company)} · <i>${p.status}</i>`;
  }).join("\n");
  return { text: `<b>In progress</b>\n\n${text}`, kb };
}

async function leadsView(m: Member) {
  const [list, status] = await Promise.all([apleo.list(), leadStatus.all()]);
  const open = list.filter(l => !status[l.id]?.[m.id] && (l.forWho === 0 || l.forWho === m.id || l.by === m.id)).slice(0, 10);
  if (!open.length) return { text: "No open leads. Share one with /lead.", kb: new InlineKeyboard() };
  const kb = new InlineKeyboard();
  const text = open.map((l, i) => {
    kb.text(`Applied ${i + 1}`, `ld:applied:${l.id}`).text(`Not for me ${i + 1}`, `ld:skip:${l.id}`).row();
    return `<b>${i + 1}.</b> <a href="${esc(l.url)}">${esc(l.title)}</a>${l.company ? ` · ${esc(l.company)}` : ""}${l.note ? `\n${esc(l.note)}` : ""}`;
  }).join("\n\n");
  return { text: `<b>Open leads for you</b>\n\n${text}`, kb };
}

export function createBot(): Bot<Ctx> | null {
  if (!env.token) return null;
  const bot = new Bot<Ctx>(env.token);

  bot.command("id", ctx => reply(ctx, `Your Telegram id: <code>${ctx.from?.id}</code>\nThis chat's id: <code>${ctx.chat.id}</code>`));

  // Only team members get past here. The admin is always a member; anyone else asks to join.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "Member";
    if (from.id === env.adminId) await members.upsert(from.id, name, from.username);
    let m = await members.get(from.id);
    if (m) {
      if (m.name !== name || m.username !== (from.username ?? null)) { await members.upsert(from.id, name, from.username); m = (await members.get(from.id))!; }
      ctx.member = m;
      return next();
    }
    if (ctx.callbackQuery) return void ctx.answerCallbackQuery({ text: "You're not on the team yet." });
    if (ctx.chat?.type !== "private") return;
    if (!env.adminId) return void reply(ctx, `This bot has no admin yet. Your id is <code>${from.id}</code>. Put it in ADMIN_USER_ID and restart.`);
    if (await kv.get(`pending:${from.id}`)) return void reply(ctx, "Your request to join is waiting for approval.");
    await kv.set(`pending:${from.id}`, JSON.stringify({ name, username: from.username ?? null }));
    await ctx.api.sendMessage(env.adminId, `<b>${esc(name)}</b>${from.username ? ` (@${esc(from.username)})` : ""} wants to join Abro.`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("Approve", `join:ok:${from.id}`).text("Decline", `join:no:${from.id}`),
    });
    await reply(ctx, "Asked the admin to add you. You'll get a message when you're in.");
  });

  bot.callbackQuery(/^join:(ok|no):(\d+)$/, async ctx => {
    if (ctx.from.id !== env.adminId) return void ctx.answerCallbackQuery({ text: "Only the admin can approve." });
    const id = Number(ctx.match[2]);
    const p = await kv.json<{ name: string; username: string | null } | null>(`pending:${id}`, null);
    await kv.del(`pending:${id}`);
    if (!p) return void ctx.answerCallbackQuery({ text: "That request is gone." });
    if (ctx.match[1] === "ok") {
      await members.upsert(id, p.name, p.username);
      await ctx.api.sendMessage(id, `You're on the team. Send /help to see what I do, or /in to clock in.`).catch(() => {});
      await ctx.editMessageText(`Added ${p.name}.`);
    } else await ctx.editMessageText(`Declined ${p.name}.`);
    await ctx.answerCallbackQuery();
  });

  bot.command("start", async ctx => {
    if (arg(ctx) === "board") {
      const kb = boardKeyboard(ctx);
      return void reply(ctx, kb ? "Here's the board." : "The board isn't online yet (PUBLIC_URL is not set).", kb);
    }
    await reply(ctx, `Welcome, ${esc(ctx.member!.name)}.\n\n${HELP}`, boardKeyboard(ctx));
  });
  bot.command("help", ctx => reply(ctx, HELP, boardKeyboard(ctx)));
  bot.command("board", ctx => {
    const kb = boardKeyboard(ctx);
    return reply(ctx, kb ? "Open the full board:" : "The board isn't online yet (PUBLIC_URL is not set).", kb);
  });

  bot.command("in", async ctx => {
    await clockIn(ctx.member!, arg(ctx) || undefined, src(ctx));
    await reply(ctx, await cardText((await members.get(ctx.member!.id))!));
  });
  bot.command("out", async ctx => {
    await clockOut(ctx.member!, arg(ctx) || undefined, src(ctx));
    await reply(ctx, await cardText((await members.get(ctx.member!.id))!));
  });
  for (const [cmd, key] of [["plan", "plan"], ["blocked", "blocker"]] as const) {
    bot.command(cmd, async ctx => {
      const m = ctx.member!;
      await days.setText(m.id, dayKey(m.tz), key, arg(ctx));
      await reply(ctx, arg(ctx) ? `Saved your ${cmd === "plan" ? "plan" : "blocker"}.` : `Cleared your ${cmd === "plan" ? "plan" : "blocker"}.`);
    });
  }
  for (const [cmd, key] of [["app", "apps"], ["reach", "outreach"], ["commit", "commits"]] as [string, CountKey][]) {
    bot.command(cmd, async ctx => {
      const n = parseInt(arg(ctx), 10);
      const m = ctx.member!;
      const d = await bump(m, key, Number.isNaN(n) ? 1 : n, src(ctx));
      const goal = { apps: m.goal_apps, outreach: m.goal_outreach, commits: m.goal_commits }[key];
      await reply(ctx, `${COUNT_LABEL[key]}: ${d[key]}/${goal}${d[key] >= goal && goal > 0 ? " ✓" : ""}`);
    });
  }

  bot.command(["todo", "shared"], async ctx => {
    const text = arg(ctx);
    const shared = ctx.message?.text?.startsWith("/shared") ?? false;
    if (!text) return void reply(ctx, `Write the todo after the command, e.g. <code>/${shared ? "shared" : "todo"} Update portfolio README</code>`);
    const id = await addTodo(ctx.member!, text, shared, src(ctx));
    await reply(ctx, `Added <code>#${id}</code>${shared ? " for the whole team" : ""}. /todos to see the list.`);
  });
  bot.command("todos", async ctx => { const v = await todosView(ctx.member!); await reply(ctx, v.text, v.kb); });
  bot.command("done", async ctx => {
    const t = await todos.get(parseInt(arg(ctx).replace("#", ""), 10));
    if (!t) return void reply(ctx, "No todo with that number. /todos shows the numbers.");
    if (!canTouchTodo(t, ctx.member!.id)) return void reply(ctx, "That one belongs to a teammate.");
    if (t.done_at) return void reply(ctx, `<code>#${t.id}</code> is already done.`);
    await todos.toggle(t.id, ctx.member!.id);
    await reply(ctx, `Done: ${esc(t.text)}`);
  });
  bot.callbackQuery(/^td:(\d+)$/, async ctx => {
    const t = await todos.get(Number(ctx.match[1]));
    if (!t || !canTouchTodo(t, ctx.member!.id)) return void ctx.answerCallbackQuery({ text: "Can't change that one." });
    if (!t.done_at) await todos.toggle(t.id, ctx.member!.id);
    await ctx.answerCallbackQuery({ text: `Done: ${t.text.slice(0, 60)}` });
    const v = await todosView(ctx.member!);
    await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.kb }).catch(() => {});
  });

  bot.command("lead", async ctx => {
    const raw = arg(ctx);
    const url = raw.match(/https?:\/\/\S+/)?.[0] ?? "";
    const rest = raw.replace(url, "").trim();
    const [head, note = ""] = rest.split("|").map(s => s.trim());
    const [title, company = ""] = (head || "").split(/\s+@\s+/).map(s => s.trim());
    if (!url || !title) return void reply(ctx, "A lead needs a link and a role. Example:\n<code>/lead https://jobs.example.com/123 Frontend Developer @ Acme | remote, React</code>");
    try {
      const { existing } = await shareLead(ctx.member!, { title, company, url, note }, src(ctx));
      await reply(ctx, existing ? "That job is already on Apleo. Added it to your leads." : "Shared. It's live on Apleo now.");
    } catch (e) { await reply(ctx, esc((e as Error).message)); }
  });
  bot.command("picks", async ctx => {
    try { const v = await picksView(ctx.member!); await reply(ctx, v.text, v.kb); }
    catch (e) { await reply(ctx, esc((e as Error).message)); }
  });
  bot.callbackQuery(/^pk:(applied|skipped):([a-f0-9]{24})$/, async ctx => {
    const slug = profileOf(ctx.member!);
    if (!slug) return void ctx.answerCallbackQuery({ text: "Set your profile on the board first." });
    const cur = (await apleoPicks.list(slug).catch(() => [])).find(p => p.id === ctx.match[2]);
    try { await apleoPicks.setStatus(ctx.match[2], slug, ctx.match[1] as "applied" | "skipped"); }
    catch (e) { return void ctx.answerCallbackQuery({ text: (e as Error).message.slice(0, 180) }); }
    if (ctx.match[1] === "applied" && cur?.status !== "applied") await bump(ctx.member!, "apps", 1, src(ctx));
    await ctx.answerCallbackQuery({ text: ctx.match[1] === "applied" ? "Marked applied (+1 application)." : "Skipped." });
    try { const v = await picksView(ctx.member!); await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.kb, link_preview_options: { is_disabled: true } }); } catch { /* unchanged */ }
  });
  bot.command("pipeline", async ctx => {
    try { const v = await pipelineView(ctx.member!); await reply(ctx, v.text, v.kb); }
    catch (e) { await reply(ctx, esc((e as Error).message)); }
  });
  bot.callbackQuery(/^po:(replied|interview|offer|rejected):([a-f0-9]{24})$/, async ctx => {
    const slug = profileOf(ctx.member!);
    const cur = (await apleoPicks.list(slug).catch(() => [])).find(p => p.id === ctx.match[2]);
    try { await apleoPicks.setStatus(ctx.match[2], slug, ctx.match[1] as PickStatus); }
    catch (e) { return void ctx.answerCallbackQuery({ text: (e as Error).message.slice(0, 180) }); }
    await ctx.answerCallbackQuery({ text: `Marked ${ctx.match[1]}.` });
    if (cur && (ctx.match[1] === "interview" || ctx.match[1] === "offer")) {
      await announce(ctx.match[1] === "offer" ? `🎉 <b>${esc(ctx.member!.name)}</b> got an offer: ${esc(cur.title)} at ${esc(cur.company)}!` : `🎤 <b>${esc(ctx.member!.name)}</b> has an interview: ${esc(cur.title)} at ${esc(cur.company)}. Wish them luck.`, { from: ctx.member!.id, sourceChat: ctx.chat?.id });
    }
    try { const v = await pipelineView(ctx.member!); await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.kb }); } catch { /* unchanged */ }
  });
  bot.command("leads", async ctx => {
    try { const v = await leadsView(ctx.member!); await reply(ctx, v.text, v.kb); }
    catch (e) { await reply(ctx, esc((e as Error).message)); }
  });
  bot.callbackQuery(/^ld:(applied|skip):([a-f0-9]{24})$/, async ctx => {
    const id = ctx.match[2];
    const prev = (await leadStatus.of(id))[ctx.member!.id];
    await leadStatus.set(id, ctx.member!.id, ctx.match[1] as "applied" | "skip");
    if (ctx.match[1] === "applied" && prev !== "applied") await bump(ctx.member!, "apps", 1, src(ctx));
    await ctx.answerCallbackQuery({ text: ctx.match[1] === "applied" ? "Marked applied (+1 application)." : "Hidden." });
    try {
      const v = await leadsView(ctx.member!);
      await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.kb, link_preview_options: { is_disabled: true } });
    } catch { /* message unchanged or Apleo unreachable */ }
  });

  bot.command("feed", async ctx => {
    const items = await feed.today();
    if (!items.length) return void reply(ctx, `Today's feed isn't built yet. It arrives at ${esc(env.feedAt)} (${esc(env.defaultTz)}).`, boardKeyboard(ctx));
    const label: Record<string, string> = { news: "News", learn: "Learn", try: "Try", idea: "Idea", spark: "Fresh idea", improve: "Improve" };
    const ms = await members.all();
    const text = items.filter(i => i.for_member === 0 || i.for_member === ctx.member!.id).slice(0, 10).map(i => {
      const who = i.for_member ? (i.for_member === ctx.member!.id ? " · for you" : ` · for ${esc(ms.find(m => m.id === i.for_member)?.name ?? "")}`) : "";
      return `<b>${label[i.kind] ?? i.kind}</b>${who}\n${i.url ? `<a href="${esc(i.url)}">${esc(i.title)}</a>` : esc(i.title)}${i.body ? `\n<i>${esc(i.body.slice(0, 300))}</i>` : ""}`;
    }).join("\n\n");
    await reply(ctx, `<b>Today's feed</b>\n\n${text}`, boardKeyboard(ctx));
  });
  bot.command("focus", async ctx => {
    const text = arg(ctx);
    if (!text) return void reply(ctx, ctx.member!.focus ? `Your focus: <i>${esc(ctx.member!.focus)}</i>\nChange it with <code>/focus …</code>` : "Tell me what you're working toward, e.g.\n<code>/focus Frontend roles, React + TypeScript, want more backend skills</code>");
    await members.setFocus(ctx.member!.id, text);
    await reply(ctx, "Saved. Tomorrow's feed will use it.");
  });

  bot.command("built", async ctx => {
    const text = arg(ctx);
    if (!text) return void reply(ctx, "Say what you made, e.g. <code>/built Ticket triage agent with Gemini and Next.js</code>");
    await addWork(ctx.member!, { kind: "project", title: text.slice(0, 160) });
    await reply(ctx, "Logged in your work. Open You on the board to send it to your portfolio or resume.", boardKeyboard(ctx));
  });
  bot.command("resume", async ctx => {
    try { await sendResume(ctx.member!); }
    catch (e) { await reply(ctx, `${esc((e as Error).message)} Do it on the board under You → Resume.`, boardKeyboard(ctx)); }
  });

  bot.command("today", async ctx => reply(ctx, await todayText(), boardKeyboard(ctx)));
  bot.command("week", async ctx => reply(ctx, await weekText()));
  bot.command("session", async ctx => {
    const s = await session.get();
    if (!s.days.length && !s.time) return void reply(ctx, "No session schedule yet. Set it on the board.", boardKeyboard(ctx));
    await reply(ctx, `<b>Live sessions</b>: ${s.days.join(", ") || "no days set"}${s.time ? ` at ${esc(s.time)} (${esc(env.defaultTz)})` : ""}${s.link ? `\n${esc(s.link)}` : ""}`);
  });
  bot.command("goals", async ctx => {
    const nums = arg(ctx).split(/\s+/).map(n => parseInt(n, 10));
    if (nums.length !== 3 || nums.some(Number.isNaN)) return void reply(ctx, "Give three numbers: applications, outreach, commits. e.g. <code>/goals 5 3 1</code>");
    await members.setGoals(ctx.member!.id, { apps: nums[0], outreach: nums[1], commits: nums[2] });
    await reply(ctx, `Daily minimums set: ${nums[0]} applications, ${nums[1]} outreach, ${nums[2]} commits.`);
  });
  bot.command("tz", async ctx => {
    const tz = arg(ctx);
    if (!tz) return void reply(ctx, `Your time zone is <code>${esc(ctx.member!.tz)}</code>. Change it with e.g. <code>/tz Asia/Shanghai</code>`);
    if (!validTz(tz)) return void reply(ctx, "That isn't a time zone name. Use the Area/City form, e.g. <code>Africa/Addis_Ababa</code> or <code>Asia/Shanghai</code>.");
    await members.setTz(ctx.member!.id, tz);
    await reply(ctx, `Time zone set to <code>${esc(tz)}</code>.`);
  });
  bot.command("team", async ctx => reply(ctx, (await members.all()).map(m => `${esc(m.name)}${m.username ? ` @${esc(m.username)}` : ""} · ${esc(m.tz)}`).join("\n")));
  bot.command("setgroup", async ctx => {
    if (ctx.from?.id !== env.adminId) return void reply(ctx, "Only the admin can do that.");
    if (ctx.chat.type === "private") return void reply(ctx, "Send /setgroup inside the group you want updates in.");
    await kv.set("group_chat_id", String(ctx.chat.id));
    await reply(ctx, "This group now gets clock-ins, leads, reminders and the nightly recap.");
  });

  bot.catch(err => console.error("bot error:", err.error));
  return bot;
}

export const COMMANDS = [
  ["in", "Clock in with today's plan"], ["out", "Clock out with what got done"],
  ["app", "Log an application"], ["reach", "Log an outreach"], ["commit", "Log a commit"],
  ["todo", "Add a todo for you"], ["shared", "Add a shared todo"], ["todos", "List todos"], ["done", "Tick off a todo by number"],
  ["picks", "Your picks from this morning"], ["pipeline", "Log replies, interviews and offers"], ["lead", "Share a job lead (posts to Apleo)"], ["leads", "Open leads"],
  ["feed", "Today's picks and ideas"], ["focus", "What you're working toward"], ["built", "Log something you made"], ["resume", "Get your resume (PDF + Word)"], ["today", "Both time cards"], ["week", "The 7-day grid"], ["board", "Open the full board"],
  ["plan", "Set today's plan"], ["blocked", "Say what's blocking you"],
  ["session", "When we meet"], ["goals", "Set daily minimums"], ["tz", "Set your time zone"], ["help", "All commands"],
].map(([command, description]) => ({ command, description }));
