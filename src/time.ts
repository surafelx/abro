// Every person keeps their own day: "today" is computed in the member's time zone.

export function validTz(tz: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

/** YYYY-MM-DD in `tz`. */
export function dayKey(tz: string, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** HH:MM (24h) in `tz`. */
export function clock(tz: string, d = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/** Mon..Sun in `tz`. */
export function weekday(tz: string, d = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
}

/** The last `n` day keys in `tz`, oldest first. */
export function lastDays(tz: string, n: number) {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(tz, new Date(Date.now() - i * 86_400_000)));
  return [...new Set(out)];
}

export const minutesOf = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Offset of `tz` from UTC at instant `d`, in minutes. */
function offsetMin(tz: string, d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}

/** Convert HH:MM today in `fromTz` to HH:MM in `toTz`. */
export function convertTime(hhmm: string, fromTz: string, toTz: string) {
  const mins = minutesOf(hhmm);
  if (mins == null) return null;
  const [y, mo, d] = dayKey(fromTz).split("-").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, 0, mins));
  const instant = new Date(guess.getTime() - offsetMin(fromTz, guess) * 60000);
  return clock(toTz, instant);
}
