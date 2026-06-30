import { asHttpUrl, firstLine, shortSha } from './format';

/** States Vercel reports for a deployment. */
export type DeploymentState =
  | 'READY'
  | 'ERROR'
  | 'BUILDING'
  | 'QUEUED'
  | 'INITIALIZING'
  | 'CANCELED'
  | 'UNKNOWN';

export type VercelErrorKind =
  | 'unauthorized' // bad/expired token
  | 'forbidden' // token lacks access to this team/project
  | 'not_found' // project/deployment/team missing
  | 'rate_limited'
  | 'http'
  | 'network';

export class VercelApiError extends Error {
  constructor(
    readonly kind: VercelErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VercelApiError';
  }
}

/** Normalised, presentation-ready view of a deployment. */
export interface NormalizedDeployment {
  id: string;
  projectName: string;
  state: DeploymentState;
  target: string | undefined;
  /** https URL of the deployment itself (always present). */
  deploymentUrl: string | undefined;
  /** Vercel dashboard "inspect" link. */
  inspectorUrl: string | undefined;
  branch: string | undefined;
  commitShort: string | undefined;
  commitMessage: string | undefined;
  /** Built from git metadata; undefined when metadata is missing. */
  commitUrl: string | undefined;
  author: string | undefined;
  timestamp: number | undefined;
}

interface RawCreator {
  username?: string;
  email?: string;
  githubLogin?: string;
}

interface RawMeta {
  githubCommitSha?: string;
  githubCommitMessage?: string;
  githubCommitRef?: string;
  githubCommitAuthorName?: string;
  githubCommitAuthorLogin?: string;
  githubOrg?: string;
  githubRepo?: string;
  githubHost?: string;
}

interface RawDeployment {
  uid: string;
  name?: string;
  url?: string;
  created?: number;
  createdAt?: number;
  ready?: number;
  buildingAt?: number;
  state?: string;
  readyState?: string;
  target?: string;
  inspectorUrl?: string;
  creator?: RawCreator;
  meta?: RawMeta;
}

const API_BASE = 'https://api.vercel.com';
const REQUEST_TIMEOUT_MS = 12_000;

function normalizeState(raw: string | undefined): DeploymentState {
  switch ((raw ?? '').toUpperCase()) {
    case 'READY':
      return 'READY';
    case 'ERROR':
      return 'ERROR';
    case 'BUILDING':
      return 'BUILDING';
    case 'QUEUED':
      return 'QUEUED';
    case 'INITIALIZING':
      return 'INITIALIZING';
    case 'CANCELED':
    case 'CANCELLED':
      return 'CANCELED';
    default:
      return 'UNKNOWN';
  }
}

function buildCommitUrl(meta: RawMeta | undefined): string | undefined {
  if (!meta?.githubCommitSha || !meta.githubOrg || !meta.githubRepo) return undefined;
  const host = meta.githubHost || 'github.com';
  // Encode path segments so an unusual org/repo/sha can't manipulate URL structure.
  const org = encodeURIComponent(meta.githubOrg);
  const repo = encodeURIComponent(meta.githubRepo);
  const sha = encodeURIComponent(meta.githubCommitSha);
  return asHttpUrl(`https://${host}/${org}/${repo}/commit/${sha}`);
}

function normalize(raw: RawDeployment): NormalizedDeployment {
  const meta = raw.meta;
  return {
    id: raw.uid,
    projectName: raw.name ?? 'unknown',
    // The v6 list endpoint carries the authoritative live status in readyState.
    state: normalizeState(raw.readyState ?? raw.state),
    target: raw.target,
    deploymentUrl: asHttpUrl(raw.url),
    inspectorUrl: asHttpUrl(raw.inspectorUrl),
    branch: meta?.githubCommitRef,
    commitShort: shortSha(meta?.githubCommitSha),
    commitMessage: firstLine(meta?.githubCommitMessage),
    commitUrl: buildCommitUrl(meta),
    author:
      meta?.githubCommitAuthorName ||
      raw.creator?.githubLogin ||
      raw.creator?.username,
    timestamp: raw.ready ?? raw.createdAt ?? raw.created,
  };
}

export class VercelClient {
  constructor(
    private readonly token: string,
    private readonly teamId: string,
  ) {}

  /** Latest production deployment for a project, or null if it has none. */
  async getLatestProductionDeployment(
    projectId: string,
  ): Promise<NormalizedDeployment | null> {
    const params = new URLSearchParams({
      projectId,
      teamId: this.teamId,
      target: 'production',
      limit: '1',
    });
    const data = await this.request<{ deployments?: RawDeployment[] }>(
      `/v6/deployments?${params.toString()}`,
    );
    const raw = data.deployments?.[0];
    if (!raw) return null;
    const deployment = normalize(raw);
    // This endpoint is filtered to target=production; the per-item target field
    // is occasionally omitted, so default it so the badge reads "Production ready".
    if (!deployment.target) deployment.target = 'production';
    return deployment;
  }

  /** Best-effort human-readable failure reason for an errored deployment. */
  async getDeploymentErrorReason(deploymentId: string): Promise<string | undefined> {
    try {
      const params = new URLSearchParams({ teamId: this.teamId });
      const data = await this.request<{
        errorMessage?: string;
        errorStep?: string;
        errorCode?: string;
      }>(`/v13/deployments/${deploymentId}?${params.toString()}`);
      return firstLine(data.errorMessage) ?? data.errorStep ?? data.errorCode;
    } catch {
      // Reason is a nice-to-have; never let it break the report.
      return undefined;
    }
  }

  private async request<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure / timeout. The message never contains the token.
      throw new VercelApiError(
        'network',
        err instanceof Error && err.name === 'AbortError'
          ? 'Vercel API request timed out'
          : 'Could not reach the Vercel API',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) throw await this.toApiError(res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new VercelApiError('http', 'Vercel returned a non-JSON response', res.status);
    }
  }

  private async toApiError(res: Response): Promise<VercelApiError> {
    // Read the body for a server message, but never echo the request/token.
    let serverMessage = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      serverMessage = body.error?.message ?? '';
    } catch {
      /* ignore non-JSON bodies */
    }
    switch (res.status) {
      case 401:
        return new VercelApiError('unauthorized', 'Vercel token is invalid or expired', 401);
      case 403:
        return new VercelApiError(
          'forbidden',
          serverMessage || 'Vercel token lacks access to this team or project',
          403,
        );
      case 404:
        return new VercelApiError('not_found', serverMessage || 'Vercel resource not found', 404);
      case 429:
        return new VercelApiError('rate_limited', 'Vercel API rate limit reached', 429);
      default:
        return new VercelApiError(
          'http',
          `Vercel API error (HTTP ${res.status})${serverMessage ? ': ' + serverMessage : ''}`,
          res.status,
        );
    }
  }
}
