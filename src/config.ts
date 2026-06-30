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

export interface AppConfig {
  telegramBotToken: string;
  vercelToken: string;
  vercelTeamId: string;
  /** Empty = everyone allowed. */
  allowedUserIds: number[];
  projects: ProjectConfig[];
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

function parseAllowedUserIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const id = Number(part);
      if (!Number.isInteger(id)) {
        throw new ConfigError(
          `ALLOWED_USER_IDS contains a non-numeric id: "${part}".`,
        );
      }
      return id;
    });
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

export function loadConfig(): AppConfig {
  return {
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    vercelToken: required('VERCEL_TOKEN'),
    vercelTeamId: required('VERCEL_TEAM_ID'),
    allowedUserIds: parseAllowedUserIds(process.env.ALLOWED_USER_IDS),
    projects: PROJECTS,
  };
}

export { ConfigError };
