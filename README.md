# Abro · አብሮ

A two-person accountability board: clock in, hit your daily minimums, share job leads, tick off todos. It runs as a Telegram bot plus a Telegram Mini App that read the same data.

- **Bot** (`src/bot.ts`, grammY, long polling): `/in`, `/out`, `/app`, `/reach`, `/commit`, `/todo`, `/shared`, `/todos`, `/done`, `/lead`, `/leads`, `/today`, `/week`, `/session`, `/goals`, `/tz`, `/board`.
- **Mini App** (`public/index.html`): Today · Todos · Leads · Week · Setup. Neo-brutalist; follows Telegram's light or dark mode. Signed in by Telegram's `initData`, checked on the server.
- **Reminders** (`src/reminders.ts`): a "clock in" DM at `NUDGE_AT` in each person's time zone, a nightly recap at `RECAP_AT`, and a heads-up 15 minutes before a live session.

## Where data lives

| What | Where |
|---|---|
| Job leads | **Apleo's** MongoDB, posted through Apleo's `/api/abro/leads`. Shared leads go live as public JOB listings on Apleo, tagged `feed: "abro"`, and retire after 30 days. |
| Tracking: members, days, todos, who applied to which lead, sessions | **Neon** Postgres (`DATABASE_URL`). With no URL, a local PGlite folder is used for dev. |

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
3. Create a Neon project and paste its connection string into `DATABASE_URL`. The tables are created on start.
4. On Apleo's API, set `ABRO_API_KEY` to a long random string. Put the same value in `APLEO_API_KEY` here, and set `APLEO_API_URL` to Apleo's API address.
5. The Mini App needs HTTPS. Locally, run a tunnel and put its URL in `PUBLIC_URL`:
   `cloudflared tunnel --url http://localhost:8787`
6. Make a Telegram group with your partner, add the bot, and send `/setgroup` there.
7. Your partner messages the bot `/start`. You tap **Approve**.

Without `BOT_TOKEN` the board still runs, and announcements print to the console. To click around in a normal browser, set `DEV_USER_ID=1` (works only from localhost).

## Deploy

Run one always-on instance; the bot long-polls, and two copies would fight over updates. There's no local state, because tracking is in Neon and leads are in Apleo, so any host that keeps a Node process running works. Set the env vars and point `PUBLIC_URL` at the host's HTTPS address.
