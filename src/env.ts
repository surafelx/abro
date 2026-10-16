import "dotenv/config";

export const env = {
  token: process.env.BOT_TOKEN ?? "",
  adminId: Number(process.env.ADMIN_USER_ID || 0),
  port: Number(process.env.PORT || 8787),
  // Render sets RENDER_EXTERNAL_URL itself, so PUBLIC_URL can stay empty there.
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, ""),
  databaseUrl: process.env.DATABASE_URL ?? "",
  apleoUrl: (process.env.APLEO_API_URL ?? "").replace(/\/+$/, ""),
  apleoKey: process.env.APLEO_API_KEY ?? "",
  defaultTz: process.env.DEFAULT_TZ || "Africa/Addis_Ababa",
  nudgeAt: process.env.NUDGE_AT || "10:00",
  recapAt: process.env.RECAP_AT || "22:00",
  devUserId: Number(process.env.DEV_USER_ID || 0),
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterModel: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
  feedAt: process.env.FEED_AT || "07:30",
  botMode: (process.env.BOT_MODE || "polling") as "polling" | "webhook",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  cronKey: process.env.CRON_KEY ?? "",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
};
