import { env } from "./env";
import { COMMANDS, createBot } from "./bot";
import { createServer } from "./server";
import { startReminders } from "./reminders";
import { setBot } from "./notify";
import { members } from "./store";

// Local browser testing: make sure the dev member exists.
if (env.devUserId && !members.get(env.devUserId)) members.upsert(env.devUserId, "Dev user");

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
