// What a member can do. The bot commands and the Mini App API both call these,
// so the team gets the same announcements whichever one was used.
import { COUNT_LABEL, CountKey, Member, days, goalsOf, hitAll, leads, members, safeUrl, todos } from "./store";
import { dayKey } from "./time";
import { announce, esc } from "./notify";

type Src = { sourceChat?: number };

export async function clockIn(m: Member, plan: string | undefined, src: Src = {}) {
  const date = dayKey(m.tz);
  const before = days.get(m.id, date);
  days.clockIn(m.id, date);
  if (plan) days.setText(m.id, date, "plan", plan);
  if (!before.in_at) {
    const p = plan || before.plan;
    await announce(`🟢 <b>${esc(m.name)}</b> clocked in.${p ? `\n<i>Plan:</i> ${esc(p)}` : ""}`, { from: m.id, ...src });
  }
}

export async function clockOut(m: Member, done: string | undefined, src: Src = {}) {
  const date = dayKey(m.tz);
  days.clockOut(m.id, date);
  if (done) days.setText(m.id, date, "done", done);
  const d = days.get(m.id, date);
  const g = goalsOf(m);
  const counts = (["apps", "outreach", "commits"] as CountKey[]).map(k => `${d[k]}/${g[k]} ${COUNT_LABEL[k].toLowerCase()}`).join(", ");
  await announce(`🔴 <b>${esc(m.name)}</b> clocked out: ${counts}.${d.done ? `\n<i>Done:</i> ${esc(d.done)}` : ""}${d.blocker ? `\n<i>Blocked:</i> ${esc(d.blocker)}` : ""}`, { from: m.id, ...src });
}

export async function bump(m: Member, key: CountKey, delta: number, src: Src = {}) {
  const date = dayKey(m.tz);
  const wasFull = hitAll(m, days.get(m.id, date));
  const d = days.bump(m.id, date, key, delta);
  if (!wasFull && hitAll(m, d)) await announce(`● <b>${esc(m.name)}</b> hit every goal for today.`, { from: m.id, ...src });
  return d;
}

export async function addLead(m: Member, l: { title: string; company?: string; url?: string; note?: string; forWho?: number }, src: Src = {}) {
  const url = l.url ? safeUrl(l.url) ?? "" : "";
  const forWho = l.forWho && members.get(l.forWho) ? l.forWho : 0;
  const id = leads.add({ by: m.id, title: l.title, company: l.company, url, note: l.note, forWho });
  const target = forWho ? (forWho === m.id ? "for themself" : `for ${esc(members.get(forWho)!.name)}`) : "for both of you";
  const head = url ? `<a href="${esc(url)}">${esc(l.title)}</a>` : esc(l.title);
  await announce(`💼 <b>${esc(m.name)}</b> shared a lead ${target}:\n${head}${l.company ? ` · ${esc(l.company)}` : ""}${l.note ? `\n${esc(l.note)}` : ""}`, { from: m.id, ...src });
  return id;
}

export async function addTodo(m: Member, text: string, shared: boolean, src: Src = {}) {
  const id = todos.add(shared ? 0 : m.id, text, m.id);
  if (shared) await announce(`📌 <b>${esc(m.name)}</b> added a shared todo: ${esc(text)}`, { from: m.id, ...src });
  return id;
}
