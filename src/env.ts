import "dotenv/config";

export const env = {
  token: process.env.BOT_TOKEN ?? "",
  adminId: Number(process.env.ADMIN_USER_ID || 0),
  port: Number(process.env.PORT || 8787),
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
  databaseUrl: process.env.DATABASE_URL ?? "",
  apleoUrl: (process.env.APLEO_API_URL ?? "").replace(/\/+$/, ""),
  apleoKey: process.env.APLEO_API_KEY ?? "",
  defaultTz: process.env.DEFAULT_TZ || "Africa/Addis_Ababa",
  nudgeAt: process.env.NUDGE_AT || "10:00",
  recapAt: process.env.RECAP_AT || "22:00",
  devUserId: Number(process.env.DEV_USER_ID || 0),
};
