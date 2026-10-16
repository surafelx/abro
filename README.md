# Abro · አብሮ

A two-person accountability board: clock in, hit your daily minimums, share job leads, tick off todos — through a Telegram bot and a Telegram Mini App that read the same data.

- **Bot** (`src/bot.ts`, grammY, long polling): `/in`, `/out`, `/app`, `/reach`, `/commit`, `/todo`, `/shared`, `/todos`, `/done`, `/lead`, `/leads`, `/today`, `/week`, `/session`, `/goals`, `/tz`, `/board`.
- **Mini App** (`public/index.html`): Today · Todos · Leads · Week · Setup. Signed in by Telegram's `initData`, checked on the server.
- **Reminders** (`src/reminders.ts`): a "clock in" DM at `NUDGE_AT` in each person's time zone, a nightly recap at `RECAP_AT`, and a heads-up 15 minutes before a live session.
- **Data**: one SQLite file (`DB_PATH`), using Node's built-in `node:sqlite`. No database server.

Joining is by approval: the admin (`ADMIN_USER_ID`) is always in. Anyone else who messages the bot sends the admin an Approve / Decline request.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

1. In Telegram, open **@BotFather** → `/newbot` → copy the token into `BOT_TOKEN`.
2. Start the bot and send it `/id`. Put that number in `ADMIN_USER_ID` and restart.
3. The Mini App needs HTTPS. Locally, run a tunnel and put its URL in `PUBLIC_URL`:
   `cloudflared tunnel --url http://localhost:8787`
4. Make a Telegram group with your partner, add the bot, and send `/setgroup` there. Clock-ins, leads, reminders and the recap go to that group.
5. Your partner messages the bot `/start`. You tap **Approve**.

Without `BOT_TOKEN` the board still runs and announcements print to the console. To click around in a normal browser, set `DEV_USER_ID=1` (works only from localhost).

## Deploy

Any host that keeps a process running and a disk between restarts works (Railway, Fly.io, Render with a disk, a small VPS). Set the env vars, mount a volume, point `DB_PATH` at it, and set `PUBLIC_URL` to the host's HTTPS address. Run a single instance: the bot long-polls, and two copies would fight over updates.
