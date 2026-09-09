import 'dotenv/config';

/**
 * Centralised, validated configuration.
 *
 * All secrets come from environment variables (see `.env.example`). Nothing in
 * here is ever logged or sent to Telegram — only the derived, non-secret
 * project metadata below is used to build messages.
 */

export interface ProjectConfig {
  /** Short label shown in the report (e.g. "Landing"). */
  label: string;
  /** Vercel project id (starts with "prj_"). */
  projectId: string;
  /**
   * Custom production domain, if the project has one. When omitted, the report
   * falls back to the latest production deployment URL fetched from Vercel.
   */
  productionDomain?: string;
}

/** A repository Viby is allowed to read, on whichever host it lives. */
export interface RepoConfig {
  /** Short alias the model uses in tool calls (e.g. "webclient"). */
  key: string;
  /** Human label for messages. */
  label: string;
  /** Which API serves this repo. */
  provider: 'github' | 'azure';
  /** GitHub: the repository owner. Azure DevOps: the project. */
  owner: string;
  name: string;
  /** Azure DevOps only: the organisation in dev.azure.com/<organization>. */
  organization?: string;
  /** Branches the model may read. Anything else is rejected. */
  branches: string[];
  /** Branch used when a tool call omits one. */
  defaultBranch: string;
  /** One line telling the model what lives in this repo. */
  summary: string;
}

export interface AppConfig {
  telegramBotToken: string;
  vercelToken: string;
  vercelTeamId: string;
  /** Secret token Telegram echoes on every webhook call (Vercel deployment). */
  telegramWebhookSecret?: string;
  /** Empty = everyone allowed. */
  allowedUserIds: number[];
  projects: ProjectConfig[];

  // ---- Viby (AI assistant) ------------------------------------------------
  openRouterApiKey: string;
  githubToken: string;
  redisUrl: string;
  redisToken: string;
  /** OpenRouter model id used until a chat picks another one. */
  defaultModel: string;
  /** Chats allowed to use the AI. Empty = every chat that passes the user allowlist. */
  allowedChatIds: number[];
  /** Max AI answers per chat per day. */
  dailyCallLimit: number;
  /** Group triggers + message capture stay off until this is switched on. */
  groupEnabled: boolean;
  /** Azure DevOps PAT. Empty = the Azure repos are not registered at all. */
  azureToken: string;
  /**
   * The PAT's expiry date (YYYY-MM-DD). A token carries no expiry you can read
   * back, and it dies quietly — the Azure repos just stop answering — so the
   * date is written down here and the daily cron warns before it arrives.
   */
  azurePatExpires: string;
  githubRepos: RepoConfig[];
  /** Empty unless `azureToken` is set — Viby is never told about a repo it cannot open. */
  azureRepos: RepoConfig[];
  /** Everything the model may read, both hosts together. */
  repos: RepoConfig[];
}

class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

/** Comma-separated integer ids. Group chat ids are negative, so signs are kept. */
function parseIdList(raw: string | undefined, varName: string): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const id = Number(part);
      if (!Number.isInteger(id)) {
        throw new ConfigError(`${varName} contains a non-numeric id: "${part}".`);
      }
      return id;
    });
}

function parsePositiveInt(raw: string | undefined, fallback: number, varName: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${varName} must be a positive integer, got "${trimmed}".`);
  }
  return value;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * The three Vibespot projects tracked by /deployments. Project ids are not
 * secret, so they live in code; the production domains were provided by the
 * project owner. `vibespot-gpt-api` has no custom domain, so it falls back to
 * the latest production deployment URL.
 */
const PROJECTS: ProjectConfig[] = [
  {
    label: 'Landing',
    projectId: 'prj_JrwQD87zk0mvfciUhRfJ1m3lVCmD',
    productionDomain: 'vibespot.com',
  },
  {
    label: 'Web Client',
    projectId: 'prj_hjOBqzD8mUju0AnPGgbpwXAV8BgQ',
    productionDomain: 'map.vibespot.com',
  },
  {
    label: 'API / AI',
    projectId: 'prj_eVfidV6MvXBUmcWyYA55CWBEb6HL',
    // No custom domain — falls back to the latest production deployment URL.
  },
];

/**
 * The GitHub repositories. Both live under the same owner, so a single
 * fine-grained token with read-only Contents access covers them.
 *
 * `master-github` is the GitHub default branch and feeds the production env;
 * `develop` is where day-to-day work lands and is usually ahead of it.
 */
const GITHUB_REPOS: RepoConfig[] = [
  {
    key: 'webclient',
    label: 'Web Client',
    provider: 'github',
    owner: 'shkarsmode',
    name: 'vibespot-webclient-public',
    branches: ['develop', 'master-github'],
    defaultBranch: 'develop',
    summary:
      'Angular 20 SSR map application (map.vibespot.com). The product itself: map, vibes, create-vibe wizard, profiles.',
  },
  {
    key: 'landing',
    label: 'Landing',
    provider: 'github',
    owner: 'shkarsmode',
    name: 'vibespot-landing-v2',
    branches: ['main'],
    defaultBranch: 'main',
    summary:
      'Static marketing site (vibespot.com): homepage, city pages, legal pages. Plain HTML/CSS/JS, no build step.',
  },
];

/**
 * The Azure DevOps repositories, under organisation `fwollo`, project
 * `Vibespot`. `owner` carries the project name; the host is what differs.
 *
 * These are registered only when AZURE_DEVOPS_PAT is present — a missing token
 * must leave the bot working on the GitHub repos rather than taking it down.
 */
const AZURE_REPOS: RepoConfig[] = [
  {
    key: 'mobile',
    label: 'Mobile Client',
    provider: 'azure',
    organization: 'fwollo',
    owner: 'Vibespot',
    name: 'mobile-client',
    branches: ['main', 'dev'],
    defaultBranch: 'dev',
    summary:
      'The iOS/Android app the team calls "native" — React Native + Expo in TypeScript, so its logic is readable and often the reference for what the web client should do.',
  },
  {
    key: 'wiki',
    label: 'Wiki',
    provider: 'azure',
    organization: 'fwollo',
    owner: 'Vibespot',
    name: 'wiki',
    branches: ['main'],
    defaultBranch: 'main',
    summary:
      'The team wiki: Markdown pages of product specs, decisions and process. Prefer this over the code when the question is about intent rather than implementation.',
  },
];

export function loadConfig(): AppConfig {
  const azureToken = process.env.AZURE_DEVOPS_PAT?.trim() || '';
  const azureRepos = azureToken ? AZURE_REPOS : [];
  return {
    azureToken,
    azurePatExpires: process.env.AZURE_PAT_EXPIRES?.trim() || '2026-12-08',
    githubRepos: GITHUB_REPOS,
    azureRepos,
    repos: [...GITHUB_REPOS, ...azureRepos],

    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    vercelToken: required('VERCEL_TOKEN'),
    vercelTeamId: required('VERCEL_TEAM_ID'),
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
    allowedUserIds: parseIdList(process.env.ALLOWED_USER_IDS, 'ALLOWED_USER_IDS'),
    projects: PROJECTS,

    openRouterApiKey: required('OPENROUTER_API_KEY'),
    githubToken: required('GITHUB_TOKEN'),
    // Vercel's Upstash Marketplace integration injects KV_REST_API_* names;
    // accept the UPSTASH_* names too so a hand-provisioned store also works.
    redisUrl: process.env.UPSTASH_REDIS_REST_URL?.trim() || required('KV_REST_API_URL'),
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || required('KV_REST_API_TOKEN'),
    defaultModel: process.env.VIBY_DEFAULT_MODEL?.trim() || 'anthropic/claude-haiku-4.5',
    allowedChatIds: parseIdList(process.env.VIBY_ALLOWED_CHAT_IDS, 'VIBY_ALLOWED_CHAT_IDS'),
    dailyCallLimit: parsePositiveInt(process.env.VIBY_DAILY_CALL_LIMIT, 100, 'VIBY_DAILY_CALL_LIMIT'),
    groupEnabled: parseBool(process.env.VIBY_GROUP_ENABLED, false),
  };
}

export { ConfigError };
