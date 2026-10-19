# Abro · አብሮ

A two-person accountability board: clock in, hit your daily minimums, share job leads, tick off todos. It runs as a Telegram bot plus a Telegram Mini App that read the same data.

- **Bot** (`src/bot.ts`, grammY, long polling): `/in`, `/out`, `/app`, `/reach`, `/commit`, `/todo`, `/shared`, `/todos`, `/done`, `/lead`, `/leads`, `/today`, `/week`, `/session`, `/goals`, `/tz`, `/board`.
- **Mini App** (`public/index.html`): a phone-style app with a bottom bar (Today · Feed · Leads · Todos) and Setup behind the header button. Neo-brutalist; follows Telegram's light or dark mode. Signed in by Telegram's `initData`, checked on the server.
- **Feed** (`src/feed.ts`): every morning at `FEED_AT`, picks from Hacker News, dev.to and GitHub's fastest-rising repos, chosen and explained for each person's focus (`/focus`, or Setup). On Sundays it adds a "what to improve" note per person, based on their week, plus two project ideas each. AI: Gemini first (`GEMINI_API_KEY`), OpenRouter as the fallback (`OPENROUTER_API_KEY`). With neither, the feed shows the top items without picks.
- **Your picks** (Leads tab, `/picks`): each morning a Claude session on Surafel's laptop checks the best new roles for every profile and saves them in Apleo. Each member sets their **Apleo profile** name in Setup (the admin defaults to `surafel`) and sees only their own picks. **I applied** or **Skip** updates Apleo's `jobPicks`, and Applied also logs an application. The bot DMs each person when a new day's picks arrive.
- **Teams:** built for a small team of any size (the pilot is three). Everyone sees each teammate's card, todos, posting progress and boosts, and leads can be for one person or the whole team.
- **Do it, show it** (`src/workActions.ts`): every feed card has **+ Todo**, **Do it** (starts it as a project or skill in your work) and **Write about it** (AI drafts a LinkedIn post, an X thread and a dev.to outline). Your work items can go **To portfolio** as a hidden draft (AI tidies the write-up), then **Publish**. Tick **Resume** on the ones to feature.
- **Brand** (You → Brand): marketing yourself, tracked like everything else.
  - A weekly posting goal (Setup), shown on both Today cards.
  - Post ideas made from your own week (plans, done, blockers, work), each turned into an X or LinkedIn draft.
  - One-tap posting through X and LinkedIn share links, so no paid APIs or keys are needed.
  - **Mark posted** sends your partner the link to boost while it's fresh.
  - A profile check rewrites your X bio, LinkedIn headline and About, and lists what to fix first.
- **Resume** (`src/writer.ts`, `src/resumeDoc.ts`): you fill a profile once, or import it from your portfolio. Abro then writes a one-page resume aimed at a role you name, from your profile and the work you ticked. You can preview it in the app, download it as PDF or Word, have the bot send both files, or put it on your portfolio.
- **Portfolio API** (`docs/PORTFOLIO_API.md`): each person links their own site in Setup (address + key; the key is encrypted with `ENCRYPTION_KEY`). Any site that implements the contract works. Surafel's portfolio26 implements it at `/api/abro`.
- **Reminders** (`src/reminders.ts`): a "clock in" DM at `NUDGE_AT` in each person's time zone, a nightly recap at `RECAP_AT`, and a heads-up 15 minutes before a live session.

**Keys from the app:** Setup → **Keys & services** (admin only) lets you set or replace the Gemini and OpenRouter keys and models, and Apleo's address and key, and test them. Values are encrypted with `ENCRYPTION_KEY` and override the host's env vars; clearing one falls back to the env var. `BOT_TOKEN`, `DATABASE_URL`, `ENCRYPTION_KEY` and `ADMIN_USER_ID` stay on the host.

## Where data lives

| What | Where |
|---|---|
| Job leads | **Apleo's** MongoDB, posted through Apleo's `/api/abro/leads`. Shared leads go live as public JOB listings on Apleo, tagged `feed: "abro"`, and retire after 30 days. |
| Tracking: members, days, todos, work, posts, feed, resume, settings | **MongoDB** (`DATABASE_URL`, e.g. a free Atlas cluster). Required. |

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
3. Create a free MongoDB Atlas cluster (or run `mongod` locally) and put its connection string in `DATABASE_URL`.
4. On Apleo's API, set `ABRO_API_KEY` to a long random string. Put the same value in `APLEO_API_KEY` here, and set `APLEO_API_URL` to Apleo's API address.
5. The Mini App needs HTTPS. Locally, run a tunnel and put its URL in `PUBLIC_URL`:
   `cloudflared tunnel --url http://localhost:8787`
6. Make a Telegram group with your partner, add the bot, and send `/setgroup` there.
7. Your partner messages the bot `/start`. You tap **Approve**.

Without `BOT_TOKEN` the board still runs, and announcements print to the console. To click around in a normal browser, set `DEV_USER_ID=1` (works only from localhost).

## Deploy

There's no local state (tracking is in MongoDB, leads are in Apleo), so any Node host works. Run a single instance.

**Free, on Render:** create a Web Service from this repo (build `npm install`, start `npm start`), and set:
- `BOT_MODE=webhook` and `WEBHOOK_SECRET`. Telegram then posts each message to `/tg`, which wakes the service.
- `PUBLIC_URL` set to the `https://….onrender.com` address.
- `CRON_KEY`. Then add a free job at cron-job.org that calls `https://…/tick?key=CRON_KEY` every 10 minutes. That runs the nudges, the recap, session reminders and the morning feed, and keeps the service awake.

**Always-on host** (Railway, Fly.io, a VPS): leave `BOT_MODE=polling`. Reminders and the feed run on an internal timer.
