import { env } from "./env";
import { days, kv, members, session } from "./store";
import { clock, dayKey, minutesOf, weekday } from "./time";
import { announce, dm, esc, todayText } from "./notify";
import { apleo } from "./apleo";

/** True during the 90 minutes after `at` (so a restart doesn't skip a reminder), once per key. */
async function due(nowHHMM: string, at: string, onceKey: string) {
  const n = minutesOf(nowHHMM), a = minutesOf(at);
  if (n == null || a == null || n < a || n > a + 90 || (await kv.get(onceKey))) return false;
  await kv.set(onceKey, "1");
  return true;
}

async function tick() {
  // Morning nudge: a DM to anyone who hasn't clocked in yet, at NUDGE_AT in their own time zone.
  for (const m of await members.all()) {
    const date = dayKey(m.tz);
    if ((await days.find(m.id, date))?.in_at) continue;
    if (await due(clock(m.tz), env.nudgeAt, `sent:nudge:${m.id}:${date}`)) {
      await dm(m.id, `Morning, ${esc(m.name)}. You haven't clocked in yet. Send <code>/in</code> with today's plan.`);
    }
  }

  // Nightly recap to the team at RECAP_AT in the default time zone.
  const tz = env.defaultTz, date = dayKey(tz);
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
