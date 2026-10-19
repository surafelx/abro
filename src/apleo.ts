import { env } from "./env";

// Job leads live in Apleo's database (published as JOB listings on apleo.xyz).
// Abro posts and reads them through Apleo's /api/abro routes.

export type Lead = {
  id: string; title: string; company: string; url: string; note: string;
  by: number | null; forWho: number; openToEthiopia: boolean; published: boolean; createdAt: string;
};

export const apleoReady = () => Boolean(env.apleoUrl && env.apleoKey);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!apleoReady()) throw new Error("Apleo isn't connected yet (set APLEO_API_URL and APLEO_API_KEY).");
  let r: Response;
  try {
    r = await fetch(`${env.apleoUrl}/api/abro${path}`, {
      method,
      headers: { "content-type": "application/json", "x-abro-key": env.apleoKey },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error("Couldn't reach Apleo. Is its API running?"); }
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!r.ok || !j.ok) throw new Error(j.error || `Apleo answered ${r.status}.`);
  return j;
}

let cache: { at: number; leads: Lead[] } | null = null;

export type Pick = {
  id: string; key: string; day: string; title: string; company: string; url: string; applyUrl: string; source: string;
  score: number; rank: number; for: string; verdict: "apply" | "maybe"; why: string; angle: string; redFlags: string[];
  verified?: { open: boolean; location: string; checkedAt: string }; pack: string; status: "new" | "applied" | "skipped" | "published"; note: string;
};
const pickCache = new Map<string, { at: number; picks: Pick[] }>();

export const clearApleoCache = () => { cache = null; pickCache.clear(); };

/** The morning triage's picks for one person (Apleo's jobPicks), newest day first. */
export const picks = {
  async list(slug: string, force = false): Promise<Pick[]> {
    const c = pickCache.get(slug);
    if (!force && c && Date.now() - c.at < 60_000) return c.picks;
    const { picks: list } = await call<{ picks: Pick[] }>("GET", `/picks?for=${encodeURIComponent(slug)}&days=14`);
    pickCache.set(slug, { at: Date.now(), picks: list });
    return list;
  },
  async setStatus(id: string, slug: string, status: "new" | "applied" | "skipped") {
    await call("PATCH", `/picks/${encodeURIComponent(id)}`, { for: slug, status });
    pickCache.delete(slug);
  },
};

export const apleo = {
  async list(force = false): Promise<Lead[]> {
    if (!force && cache && Date.now() - cache.at < 60_000) return cache.leads;
    const { leads } = await call<{ leads: Lead[] }>("GET", "/leads?limit=100");
    cache = { at: Date.now(), leads };
    return leads;
  },
  async get(id: string) { return (await apleo.list()).find(l => l.id === id); },
  async share(l: { title: string; company?: string; url: string; note?: string; by: number; forWho: number; openToEthiopia: boolean }) {
    const res = await call<{ lead: Lead; existing?: boolean }>("POST", "/leads", l);
    cache = null;
    return res;
  },
  async remove(id: string) { await call("DELETE", `/leads/${encodeURIComponent(id)}`); cache = null; },
};
