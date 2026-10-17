import "dotenv/config";

// Values set from the app (Setup → Keys & services) win over the host's env vars.
// settings.ts loads them from the database at start and whenever they change.
const overrides = new Map<string, string>();
export const setOverride = (name: string, value: string | null) => { if (value) overrides.set(name, value); else overrides.delete(name); };
export const hasOverride = (name: string) => overrides.has(name);
const pick = (name: string) => overrides.get(name) ?? process.env[name] ?? "";

export const env = {
  token: process.env.BOT_TOKEN ?? "",
  adminId: Number(process.env.ADMIN_USER_ID || 0),
  port: Number(process.env.PORT || 8787),
  // Render sets RENDER_EXTERNAL_URL itself, so PUBLIC_URL can stay empty there.
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, ""),
  databaseUrl: process.env.DATABASE_URL ?? "",
  get apleoUrl() { return pick("APLEO_API_URL").replace(/\/+$/, ""); },
  get apleoKey() { return pick("APLEO_API_KEY"); },
  defaultTz: process.env.DEFAULT_TZ || "Africa/Addis_Ababa",
  nudgeAt: process.env.NUDGE_AT || "10:00",
  recapAt: process.env.RECAP_AT || "22:00",
  devUserId: Number(process.env.DEV_USER_ID || 0),
  get geminiKey() { return pick("GEMINI_API_KEY"); },
  get geminiModel() { return pick("GEMINI_MODEL") || "gemini-2.5-flash"; },
  get openrouterKey() { return pick("OPENROUTER_API_KEY"); },
  get openrouterModel() { return pick("OPENROUTER_MODEL") || "google/gemini-2.5-flash"; },
  feedAt: process.env.FEED_AT || "07:30",
  botMode: (process.env.BOT_MODE || "polling") as "polling" | "webhook",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  cronKey: process.env.CRON_KEY ?? "",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
};
