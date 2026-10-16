import "dotenv/config";

export const env = {
  token: process.env.BOT_TOKEN ?? "",
  adminId: Number(process.env.ADMIN_USER_ID || 0),
  port: Number(process.env.PORT || 8787),
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
  dbPath: process.env.DB_PATH || "./data/abro.db",
  defaultTz: process.env.DEFAULT_TZ || "Africa/Addis_Ababa",
  nudgeAt: process.env.NUDGE_AT || "10:00",
  recapAt: process.env.RECAP_AT || "22:00",
  devUserId: Number(process.env.DEV_USER_ID || 0),
};
