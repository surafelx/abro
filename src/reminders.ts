import { env } from "./env";
import { days, kv, members, session } from "./store";
import { clock, dayKey, minutesOf, weekday } from "./time";
import { announce, dm, esc, todayText } from "./notify";
import { apleo } from "./apleo";
import { buildDaily, buildWeekly, feed } from "./feed";

/** True during the 90 minutes after `at` (so a restart or a late /tick doesn't skip it), once per key. */
async function due(nowHHMM: string, at: string, onceKey: string) {
  const n = minutesOf(nowHHMM), a = minutesOf(at);
  if (n == null || a == null || n < a || n > a + 90 || (await kv.get(onceKey))) return false;
  await kv.set(onceKey, "1");
  return true;
}

const KIND_LABEL: Record<string, string> = { news: "News", learn: "Learn", try: "Try", idea: "Idea", spark: "Fresh idea", improve: "Improve" };

export async function postFeedDigest() {
  const items = (await feed.today()).filter(i => i.kind !== "improve").slice(0, 6);
  if (!items.length) return;
  const ms = await members.all();
  const who = (id: number) => (id ? ms.find(m => m.id === id)?.name ?? "" : "");
  const lines = items.map(i => `<b>${KIND_LABEL[i.kind] ?? i.kind}</b>${who(i.for_member) ? ` · for ${esc(who(i.for_member))}` : ""}\n${i.url ? `<a href="${esc(i.url)}">${esc(i.title)}</a>` : esc(i.title)}${i.body ? `\n<i>${esc(i.body.split("\n")[0].slice(0, 220))}</i>` : ""}`);
  await announce(`<b>Today's feed</b>\n\n${lines.join("\n\n")}\n\nMore on the board's Feed tab, or send /feed.`);
}

/** Everything time-based. Runs every minute in polling mode, or on each GET /tick in webhook mode. */
export async function tick() {
  // Morning nudge: a DM to anyone who hasn't clocked in yet, at NUDGE_AT in their own time zone.
  for (const m of await members.all()) {
    const date = dayKey(m.tz);
    if ((await days.find(m.id, date))?.in_at) continue;
    if (await due(clock(m.tz), env.nudgeAt, `sent:nudge:${m.id}:${date}`)) {
      await dm(m.id, `Morning, ${esc(m.name)}. You haven't clocked in yet. Send <code>/in</code> with today's plan.`);
    }
  }

  const tz = env.defaultTz, date = dayKey(tz);

  // Daily feed (and on Sundays, the weekly notes and project ideas), then a digest to the team.
  if (await due(clock(tz), env.feedAt, `sent:feed:${date}`)) {
    const d = await buildDaily().catch(e => { console.error("daily feed failed", e); return null; });
    if (weekday(tz) === "Sun") await buildWeekly().catch(e => console.error("weekly feed failed", e));
    if (d?.added) await postFeedDigest();
    if (weekday(tz) === "Sun") await announce("Your weekly notes and new project ideas are on the board's Feed tab.");
  }

  // Nightly recap to the team at RECAP_AT.
  if (await due(clock(tz), env.recapAt, `sent:recap:${date}`)) {
    const since = Date.now() - 86_400_000;
    const n = await apleo.list(true).then(ls => ls.filter(l => +new Date(l.createdAt) >= since).length).catch(() => 0);
    await announce(`<b>Today's recap</b>\n\n${await todayText()}${n ? `\n\n${n} lead${n === 1 ? "" : "s"} shared in the last 24 hours.` : ""}`);
  }

  // Live session: a heads-up 15 minutes before, on session days.
  const s = await session.get();
  const start = minutesOf(s.time);
  if (start != null && start >= 15 && s.days.includes(weekday(tz))) {
    const before = start - 15;
    const at = `${String(Math.floor(before / 60)).padStart(2, "0")}:${String(before % 60).padStart(2, "0")}`;
    if (await due(clock(tz), at, `sent:session:${date}`)) {
      await announce(`⏰ Session in 15 minutes (${esc(s.time)}).${s.link ? `\n${esc(s.link)}` : ""}`);
    }
  }
}

export function startReminders() {
  const run = () => tick().catch(e => console.error("reminder error", e));
  setTimeout(run, 5_000);
  return setInterval(run, 60_000);
}
