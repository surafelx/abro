// Keys and service settings the admin can change from the app (Setup → Keys & services).
// Stored in kv as `setting:<NAME>`, secrets encrypted with ENCRYPTION_KEY. A value set here
// overrides the host's env var of the same name; clearing it falls back to the env var.
import { env, hasOverride, setOverride } from "./env";
import { kv } from "./store";
import { open, seal } from "./work";

export type SettingDef = { name: string; label: string; group: "AI" | "Apleo"; secret: boolean; placeholder: string; check?: (v: string) => string | null };

const isUrl = (v: string) => (/^https?:\/\/\S+$/.test(v) ? null : "Use a full address starting with https://");

export const SETTINGS: SettingDef[] = [
  { name: "GEMINI_API_KEY", label: "Gemini API key", group: "AI", secret: true, placeholder: "AIza…" },
  { name: "GEMINI_MODEL", label: "Gemini model", group: "AI", secret: false, placeholder: "gemini-2.5-flash" },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter API key (fallback)", group: "AI", secret: true, placeholder: "sk-or-…" },
  { name: "OPENROUTER_MODEL", label: "OpenRouter model", group: "AI", secret: false, placeholder: "google/gemini-2.5-flash" },
  { name: "APLEO_API_URL", label: "Apleo API address", group: "Apleo", secret: false, placeholder: "https://api.apleo.xyz", check: isUrl },
  { name: "APLEO_API_KEY", label: "Apleo API key", group: "Apleo", secret: true, placeholder: "Same as ABRO_API_KEY on Apleo" },
];
const byName = new Map(SETTINGS.map(s => [s.name, s]));

const listeners: (() => void)[] = [];
export const onSettingsChange = (fn: () => void) => { listeners.push(fn); };

/** Load saved settings into the env overrides. Call once after the database connects. */
export async function loadSettings() {
  const rows = await kv.startingWith("setting:");
  for (const r of rows) {
    const name = r.key.slice("setting:".length);
    const def = byName.get(name);
    if (!def) continue;
    try { setOverride(name, def.secret ? open(r.value) : r.value); }
    catch { console.warn(`Couldn't read the saved ${name} (was ENCRYPTION_KEY changed?). Using the env var instead.`); }
  }
}

const current = (name: string) => {
  const map: Record<string, string> = {
    GEMINI_API_KEY: env.geminiKey, GEMINI_MODEL: env.geminiModel, OPENROUTER_API_KEY: env.openrouterKey,
    OPENROUTER_MODEL: env.openrouterModel, APLEO_API_URL: env.apleoUrl, APLEO_API_KEY: env.apleoKey,
  };
  return map[name] ?? "";
};
const mask = (v: string) => (v.length <= 8 ? "••••" : `••••${v.slice(-4)}`);

/** What the Setup screen shows: never a secret in full. */
export function describeSettings() {
  return SETTINGS.map(s => {
    const v = current(s.name);
    const source = hasOverride(s.name) ? "app" : process.env[s.name] ? "server" : v ? "default" : "none";
    return { name: s.name, label: s.label, group: s.group, secret: s.secret, placeholder: s.placeholder, set: Boolean(v), source, preview: !v ? "" : s.secret ? mask(v) : v };
  });
}

export async function saveSetting(name: string, raw: string) {
  const def = byName.get(name);
  if (!def) throw new Error("Unknown setting.");
  const value = raw.trim().slice(0, 500);
  if (value) {
    const problem = def.check?.(value);
    if (problem) throw new Error(problem);
    if (def.secret && !env.encryptionKey) throw new Error("Set ENCRYPTION_KEY on the server first, so keys can be stored safely.");
    await kv.set(`setting:${name}`, def.secret ? seal(value) : value);
    setOverride(name, value);
  } else {
    await kv.del(`setting:${name}`);
    setOverride(name, null);
  }
  for (const fn of listeners) fn();
}
