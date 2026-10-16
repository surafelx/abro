import { env } from "./env";
import { connectDb } from "./db";
import { COMMANDS, createBot } from "./bot";
import { createServer } from "./server";
import { startReminders } from "./reminders";
import { setBot } from "./notify";
import { members } from "./store";
import { apleoReady } from "./apleo";

await connectDb();

// Local browser testing: make sure the dev member exists.
if (env.devUserId && !(await members.get(env.devUserId))) await members.upsert(env.devUserId, "Dev user");
if (!apleoReady()) console.log("APLEO_API_URL / APLEO_API_KEY not set: leads are off until Apleo is connected.");

const app = createServer();
app.listen(env.port, () => console.log(`Abro board on http://localhost:${env.port}${env.publicUrl ? ` (public: ${env.publicUrl})` : ""}`));

const bot = createBot();
if (bot) {
  await bot.init();
  setBot(bot as never);
  await bot.api.setMyCommands(COMMANDS).catch(e => console.warn("setMyCommands failed", e.message));
  if (env.publicUrl.startsWith("https://")) {
    await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Board", web_app: { url: env.publicUrl } } }).catch(e => console.warn("menu button failed", e.message));
  }
  bot.start({ drop_pending_updates: false, onStart: me => console.log(`Bot @${me.username} is polling`) });
  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
} else {
  console.log("BOT_TOKEN not set: running the board only. Announcements are printed here instead of sent.");
}

startReminders();
