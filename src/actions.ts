// What a member can do. The bot commands and the Mini App API both call these,
// so the team gets the same announcements whichever one was used.
import { COUNT_LABEL, CountKey, Member, days, goalsOf, hitAll, members, safeUrl, todos } from "./store";
import { dayKey } from "./time";
import { announce, esc } from "./notify";
import { apleo } from "./apleo";

type Src = { sourceChat?: number };

export async function clockIn(m: Member, plan: string | undefined, src: Src = {}) {
  const date = dayKey(m.tz);
  const before = await days.get(m.id, date);
  await days.clockIn(m.id, date);
  if (plan) await days.setText(m.id, date, "plan", plan);
  if (!before.in_at) {
    const p = plan || before.plan;
    await announce(`🟢 <b>${esc(m.name)}</b> clocked in.${p ? `\n<i>Plan:</i> ${esc(p)}` : ""}`, { from: m.id, ...src });
  }
}

export async function clockOut(m: Member, done: string | undefined, src: Src = {}) {
  const date = dayKey(m.tz);
  await days.clockOut(m.id, date);
  if (done) await days.setText(m.id, date, "done", done);
  const d = await days.get(m.id, date);
  const g = goalsOf(m);
  const counts = (["apps", "outreach", "commits"] as CountKey[]).map(k => `${d[k]}/${g[k]} ${COUNT_LABEL[k].toLowerCase()}`).join(", ");
  await announce(`🔴 <b>${esc(m.name)}</b> clocked out: ${counts}.${d.done ? `\n<i>Done:</i> ${esc(d.done)}` : ""}${d.blocker ? `\n<i>Blocked:</i> ${esc(d.blocker)}` : ""}`, { from: m.id, ...src });
}

export async function bump(m: Member, key: CountKey, delta: number, src: Src = {}) {
  const date = dayKey(m.tz);
  const wasFull = hitAll(m, await days.get(m.id, date));
  const d = await days.bump(m.id, date, key, delta);
  if (!wasFull && hitAll(m, d)) await announce(`● <b>${esc(m.name)}</b> hit every goal for today.`, { from: m.id, ...src });
  return d;
}

/** Share a lead: it's posted to Apleo (public job listing), then announced to the team. */
export async function shareLead(m: Member, l: { title: string; company?: string; url: string; note?: string; forWho?: number; openToEthiopia?: boolean }, src: Src = {}) {
  const url = safeUrl(l.url);
  if (!url) throw new Error("The lead needs a link starting with https://");
  const forWho = l.forWho && (await members.get(l.forWho)) ? l.forWho : 0;
  const { lead, existing } = await apleo.share({ title: l.title, company: l.company, url, note: l.note, by: m.id, forWho, openToEthiopia: l.openToEthiopia !== false });
  const target = forWho ? (forWho === m.id ? "for themself" : `for ${esc((await members.get(forWho))!.name)}`) : "for both of you";
  await announce(`💼 <b>${esc(m.name)}</b> shared a lead ${target}:\n<a href="${esc(lead.url)}">${esc(lead.title)}</a>${lead.company ? ` · ${esc(lead.company)}` : ""}${l.note ? `\n${esc(l.note)}` : ""}${existing ? "\n(Already on Apleo.)" : ""}`, { from: m.id, ...src });
  return { lead, existing };
}

export async function addTodo(m: Member, text: string, shared: boolean, src: Src = {}) {
  const id = await todos.add(shared ? 0 : m.id, text, m.id);
  if (shared) await announce(`📌 <b>${esc(m.name)}</b> added a shared todo: ${esc(text)}`, { from: m.id, ...src });
  return id;
}
