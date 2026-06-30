# Vibespot Ops — Telegram bot

A small, production-minded Telegram bot for the Vibespot project. Built with
Node.js + TypeScript and [grammY](https://grammy.dev/). No framework overhead.

## Commands

| Command | What it does |
| --- | --- |
| `/deployments` | Fetches the **latest production deployment** for the three Vibespot projects from the Vercel API and returns a compact, mobile-friendly report (status, domain, Vercel link, GitHub commit link, branch, commit, time, author, and failure reason if failed). |
| `/help` | Shows usage. |

The bot tracks these Vercel projects (under the `wondrlink` team):

- **Landing** — `vibespot-landing-v2` → `vibespot.com`
- **Web Client** — `vibespot-webclient-public` → `map.vibespot.com`
- **API / AI** — `vibespot-gpt-api` → latest production deployment URL (no custom domain)

## Prerequisites

- Node.js 18.17+ (developed on Node 22)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Vercel API token from <https://vercel.com/account/tokens>, scoped to the team that owns the projects

## Environment variables

Copy `.env.example` to `.env` and fill it in. **Never commit `.env`.**

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from BotFather. |
| `VERCEL_TOKEN` | yes | Vercel API token (scoped to the team). |
| `VERCEL_TEAM_ID` | yes | Vercel team id that owns the projects (`team_…`). |
| `TELEGRAM_WEBHOOK_SECRET` | webhook only | Random secret Telegram echoes on every webhook call (Vercel deployment). Not needed for local polling. |
| `ALLOWED_USER_IDS` | no | Comma-separated Telegram numeric user ids allowed to use the bot. Empty = everyone (fine for local testing). |

## Install

```bash
npm install
```

## Run locally

Development (TypeScript directly, no build step):

```bash
npm run start:dev      # run once
npm run dev            # run with auto-reload on file changes
```

Production:

```bash
npm run build          # compile to dist/
npm start              # node dist/index.js
```

Type-check only:

```bash
npm run typecheck
```

The bot uses **long polling**, so no public URL or webhook is needed — it works
from any machine with outbound internet access.

## Deploy to Vercel (always-on, webhook)

Vercel is serverless and cannot keep a long-polling process alive, so the
deployment runs the bot in **webhook** mode via the `api/bot.ts` serverless
function (`src/index.ts` long polling is only for local development).

1. Set the four env vars in the Vercel project (Settings → Environment
   Variables): `TELEGRAM_BOT_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
   `TELEGRAM_WEBHOOK_SECRET`.
2. Deploy. The webhook endpoint is `https://<project>.vercel.app/api/bot`
   (a `GET` there returns a health-check string).
3. Register the webhook with Telegram (once):

   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.vercel.app/api/bot&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```

The bot is then always-on — no local process required. Switching back to local
polling later just needs `deleteWebhook` and `npm run start:dev`.

## Security

- All secrets live in `.env` (git-ignored). Nothing secret is hardcoded.
- Tokens are never logged or sent to Telegram. The logger additionally redacts
  anything that looks like a token as defense-in-depth.
- The Vercel token has **no expiration**; rotate it periodically at
  <https://vercel.com/account/tokens> and update `.env`.
- Deployment URLs are always fetched live from the Vercel API — only the stable
  custom domains are configured.

## Project structure

```
src/
  index.ts              # local entry: long-polling launcher
  bot.ts                # shared bot factory (commands + handlers)
  config.ts             # env loading/validation + project registry
  logger.ts             # tiny logger with secret redaction
  format.ts             # HTML escaping, time-ago, short SHA, URL helpers
  vercel.ts             # Vercel API client + deployment normalization
  commands/
    deployments.ts      # builds the /deployments report
api/
  bot.ts                # Vercel serverless webhook endpoint (/api/bot)
```
