import type { Bot } from "grammy";
import { env } from "./env";
import { COUNT_KEYS, COUNT_LABEL, Member, days, goalsOf, groupChatId, hitAll, members, todos } from "./store";
import { clock, dayKey, lastDays } from "./time";

let bot: Bot | null = null;
export const setBot = (b: Bot | null) => { bot = b; };
export const botUsername = () => bot?.botInfo?.username ?? "";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function send(chat: number, text: string) {
  if (!bot) { console.log(`[dry → ${chat}] ${text.replace(/<[^>]+>/g, "").slice(0, 160)}`); return; }
  try { await bot.api.sendMessage(chat, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); }
  catch (e) { console.warn("send failed", chat, (e as Error).message); }
}

export const dm = (member: number, text: string) => send(member, text);

/**
 * Tell the team. Goes to the group chat when one is set (/setgroup), otherwise
 * to everyone except the person who did it. Skips the chat the action came from.
 */
export async function announce(text: string, opts: { from?: number; sourceChat?: number } = {}) {
  const g = groupChatId();
  const targets = g ? [g] : members.all().filter(m => m.id !== opts.from).map(m => m.id);
  for (const chat of targets) if (chat !== opts.sourceChat) await send(chat, text);
}

const hm = (m: Member, iso: string | null) => (iso ? clock(m.tz, new Date(iso)) : "--:--");

export function cardText(m: Member) {
  const d = days.get(m.id, dayKey(m.tz));
  const g = goalsOf(m);
  const counts = COUNT_KEYS.map(k => `${COUNT_LABEL[k]} ${d[k]}/${g[k]}${d[k] >= g[k] && g[k] > 0 ? " ✓" : ""}`).join(" · ");
  const open = todos.openFor(m.id).filter(t => t.owner === m.id).length;
  const lines = [
    `<b>${esc(m.name)}</b>  IN ${hm(m, d.in_at)} · OUT ${hm(m, d.out_at)}${hitAll(m, d) ? "  ● all goals hit" : ""}`,
    counts,
  ];
  if (d.plan) lines.push(`<i>Plan:</i> ${esc(d.plan)}`);
  if (d.done) lines.push(`<i>Done:</i> ${esc(d.done)}`);
  if (d.blocker) lines.push(`<i>Blocked:</i> ${esc(d.blocker)}`);
  lines.push(`${open} open todo${open === 1 ? "" : "s"}`);
  return lines.join("\n");
}

export function todayText() {
  const ms = members.all();
  return ms.length ? ms.map(cardText).join("\n\n") : "No one on the team yet.";
}

export function weekText() {
  const ms = members.all();
  if (!ms.length) return "No one on the team yet.";
  const rows = ms.map(m => {
    const keys = lastDays(m.tz, 7);
    let apps = 0, full = 0;
    const marks = keys.map(k => {
      const d = days.find(m.id, k);
      if (d) apps += d.apps;
      if (hitAll(m, d)) { full++; return "●"; }
      return d && (d.in_at || d.apps || d.outreach || d.commits) ? "◐" : "·";
    }).join(" ");
    return `<b>${esc(m.name)}</b>\n<code>${marks}</code>  ${apps} apps · ${full}/7 full days`;
  });
  return `<b>Last 7 days</b> (oldest → today)\n● every goal hit  ◐ worked  · nothing logged\n\n${rows.join("\n\n")}`;
}

export const boardReady = () => env.publicUrl.startsWith("https://");
