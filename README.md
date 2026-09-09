# Viby — Vibespot Telegram bot

**Viby** (`@vibespot_ops_bot`) is the Vibespot engineering assistant in Telegram.
It answers questions about the codebase in English — concisely, with real file
paths — and reports deployment status. Node.js + TypeScript on
[grammY](https://grammy.dev/), deployed as a Vercel serverless webhook.

## Commands

| Command | What it does |
| --- | --- |
| `/ask` | Ask about the codebase. In a DM you can just type the question. |
| `/deployments` | Latest **production** deployment for Landing, Web Client and API/AI, from the Vercel API. |
| `/model` | Switch model with inline buttons (cost vs depth). |
| `/effort` | How hard Viby thinks *and* how many files it may read. |
| `/remember` · `/memory` · `/forget` | Per-chat memory. "Viby, remember that …" works too and costs nothing. |
| `/usage` | Today's answers, tokens and cost. |
| `/help` | Usage. |

## How it answers without burning tokens

The web client is ~900 files / ~125k lines — about **1.2M tokens**. It can never
go in a prompt. So Viby uses *agentic retrieval*:

1. A small always-loaded brief (~2.5k tokens): who Viby is, what Vibespot is, a
   repo/code map, and team knowledge (branch flow, the dev/prod API split, where
   the AI prompts actually live). It is the first system message so it can carry
   a **prompt-cache breakpoint**.
2. Five read-only tools it calls only when needed: `list_files`, `outline_file`,
   `read_file`, `search_code`, `get_deployments`.

`outline_file` is the workhorse: `core.component.ts` is 7,925 lines
(~85k tokens) but outlines to ~4.3k — a 20× reduction — after which Viby reads
only the line range it needs.

**Measured cost (Haiku 4.5):** ~$0.005 for a question the brief already answers
(zero tool calls), ~$0.015–0.03 for a real code question.

### Repos it reads

| Alias | Repo | Branches |
| --- | --- | --- |
| `webclient` | `shkarsmode/vibespot-webclient-public` (private) | `develop` (default), `master-github` (prod) |
| `landing` | `shkarsmode/vibespot-landing-v2` | `main` |

Read live from GitHub, so answers reflect the current code — no re-indexing.
Note `search_code` only indexes each repo's **default branch**, so Viby confirms
hits with `read_file` on the branch you asked about.

## Security

- **`src/environments/**` is blocked outright** — it holds live Mapbox and
  TimeZoneDB tokens. Lockfiles, keys and binaries are blocked too.
- Everything fetched is scrubbed, and the finished answer is scrubbed again.
  Scrubbing matches credential *shapes* **and** `token: '…'`-style assignments —
  the latter is the only thing that catches a shapeless value like a 12-character
  TimeZoneDB token.
- Repo file contents are treated as untrusted data; Viby is told never to follow
  instructions found inside them.
- Tokens never reach logs: `logger.ts` scrubs by exact value and by pattern.
- The GitHub token is **read-only, fine-grained, scoped to exactly those two
  repos** (verified: any other repo returns 404). It has **no expiry** — revoke or
  rotate it at <https://github.com/settings/personal-access-tokens>.

## Environment variables

Copy `.env.example` to `.env`. **Never commit `.env`.**

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather. |
| `VERCEL_TOKEN` / `VERCEL_TEAM_ID` | yes | For `/deployments`. |
| `TELEGRAM_WEBHOOK_SECRET` | webhook | Secret Telegram echoes on every call. |
| `OPENROUTER_API_KEY` | yes | <https://openrouter.ai/keys> |
| `GITHUB_TOKEN` | yes | Fine-grained PAT, Contents + Metadata read-only. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | yes | Upstash Redis. Injected automatically by the Vercel integration; `UPSTASH_REDIS_REST_URL`/`_TOKEN` are also accepted. |
| `VIBY_DEFAULT_MODEL` | no | Default `anthropic/claude-haiku-4.5`. |
| `VIBY_DAILY_CALL_LIMIT` | no | Answers per chat per UTC day. Default 100. |
| `ALLOWED_USER_IDS` | **yes in prod** | Numeric ids allowed to DM the bot, and the only maintainers. Empty = **everyone**. |
| `VIBY_ALLOWED_CHAT_IDS` | **yes in prod** | Group chat ids the bot serves (negative). Empty = no groups, once `ALLOWED_USER_IDS` is set. |
| `VIBY_GROUP_ENABLED` | no | **The phase gate.** `false` = completely silent in groups. |

## Who can use it

Two lists, checked by `src/access.ts` before any handler runs:

| | DM | Listed group | Anywhere else |
| --- | --- | --- | --- |
| **In `ALLOWED_USER_IDS`** | full access | full access | silence |
| **Anyone else** | refused, one line | may ask questions and run `/deployments`; cannot change model, effort or memory | silence |

A group is served only when `VIBY_GROUP_ENABLED=true` **and** its id is listed —
the phase gate is checked first, so adding an id while the flag is off changes
nothing. Any group that fails either test gets **no reply at all**, not even a
refusal, so the bot can never spam a chat it was added to by mistake.
(A basic group promoted to a supergroup gets a new id and falls silent until the
new one is listed.) Both lists empty = fully open;
that is the local-development default and must not ship.

`/whoami` is the one command that runs *before* the gate: it echoes the caller's
own user and chat id back to them, which is the only way to read a Telegram
numeric id and therefore the only way to bootstrap the lists.

## Run

```bash
npm install
npm run typecheck        # the gate: strict + noUnusedLocals/Parameters
npm run start:dev        # local, long polling
npm run build && npm start
```

Local long polling **conflicts with the production webhook** — delete the webhook
first (`deleteWebhook`) or just test against the deployed bot.

Production is a Vercel webhook at `/api/bot`. It acknowledges Telegram
immediately and finishes the answer in the background (`waitUntil`), with
`update_id` de-duplication in Redis so a Telegram retry can't double-bill.

## Group rollout

Groups stay **off** until `VIBY_GROUP_ENABLED=true`. Before flipping it:

1. BotFather → `/setprivacy` → **Disable** (needed to read chat context).
2. **Remove and re-add** the bot to the group — Telegram requires this for the
   privacy change to take effect.
3. Run `/whoami` in the group, put the (negative) id in `VIBY_ALLOWED_CHAT_IDS`, redeploy.

Then Viby answers to `Viby …`, an @mention, a reply to itself, or `/ask`, and
introduces itself once when added.

## Project structure

```
src/
  index.ts         # local entry: long-polling launcher
  bot.ts           # the single wiring point: middleware, commands, handlers
  config.ts        # env loading/validation + repo registry
  store.ts         # Upstash Redis: settings, memory, history, usage, locks, cache
  github.ts        # GitHub client + secret scrubber + path denylist
  telegram-md.ts   # Markdown -> Telegram HTML + safe message splitting
  triggers.ts      # "is this for Viby?" — the group phase gate
  background.ts    # ack-then-work (waitUntil)
  format.ts        # escaping, time-ago, URL helpers
  vercel.ts        # Vercel API client
  ai/
    context.ts     # the always-loaded project brief
    models.ts      # model catalog + effort profiles
    prompt.ts      # prompt layering and budgets
    tools.ts       # tool schemas + dispatcher
    loop.ts        # the tool-calling loop
    openrouter.ts  # OpenRouter client
  commands/
    ask.ts deployments.ts settings.ts memory.ts intro.ts
api/
  bot.ts           # Vercel webhook
```
