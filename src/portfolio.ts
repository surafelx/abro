// Client for a person's portfolio API (contract: docs/PORTFOLIO_API.md).
import { Links, Profile, Work, linksOf, portfolioLinks, slugOf } from "./work";

async function call<T>(member: number | { url: string; key: string }, method: string, path: string, body?: unknown): Promise<T> {
  const link = typeof member === "number" ? await portfolioLinks.get(member) : member;
  if (!link) throw new Error("Link your portfolio in Setup first (its API address and key).");
  let r: Response;
  try {
    r = await fetch(`${link.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${link.key}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new Error("Couldn't reach your portfolio's API."); }
  const j = (await r.json().catch(() => ({}))) as { error?: string } & T;
  if (r.status === 401) throw new Error("Your portfolio rejected the key. Check it in Setup.");
  if (!r.ok) throw new Error(j.error || `Your portfolio answered ${r.status}.`);
  return j;
}

export type Entry = { id: string; kind: string; title: string; summary: string; details: string; stack: string[]; links: Links; date: string; visible: boolean };

export function entryOf(w: Work): Entry {
  const d = new Date(w.updated_at);
  return {
    id: slugOf(w),
    kind: w.kind,
    title: w.title,
    summary: w.summary,
    details: w.details,
    stack: w.stack.split(",").map(s => s.trim()).filter(Boolean),
    links: linksOf(w),
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    visible: w.portfolio_state === "live",
  };
}

export const portfolio = {
  /** Send (or re-send) the entry as a hidden draft. */
  putDraft: (member: number, w: Work) => call<{ entry: Entry; url?: string }>(member, "PUT", `/entries/${encodeURIComponent(slugOf(w))}`, { ...entryOf(w), visible: false }),
  setVisible: (member: number, w: Work, visible: boolean) => call<{ entry: Entry; url?: string }>(member, "PATCH", `/entries/${encodeURIComponent(slugOf(w))}`, { visible }),
  remove: (member: number, w: Work) => call<{ ok: boolean }>(member, "DELETE", `/entries/${encodeURIComponent(slugOf(w))}`),
  profile: (member: number) => call<Profile>(member, "GET", "/profile"),
  putResume: (member: number, pdf: Buffer, docx: Buffer) =>
    call<{ pdfUrl?: string; docxUrl?: string }>(member, "PUT", "/resume", { pdf: pdf.toString("base64"), docx: docx.toString("base64"), updatedAt: new Date().toISOString() }),
  /** Try an address and key before saving them. */
  test: (url: string, key: string) => call<{ entries: Entry[] }>({ url: url.replace(/\/+$/, ""), key }, "GET", "/entries"),
};
