import type { RepoConfig } from './config';
import {
  type ChangeSet,
  type CodeHit,
  type CommitInfo,
  type FileSlice,
  type RepoErrorKind,
  type TreeEntry,
  deniedPathReason,
  MAX_FILE_CHARS,
  MAX_FILE_LINES,
  outlineOf,
  pathMatchesQuery,
  PathDeniedError,
  RepoApiError,
  scrubSecrets,
} from './repo-read';
import type { Store } from './store';

/** GitHub's flavour of the shared error, so a stack trace still names the source. */
export class GithubApiError extends RepoApiError {
  constructor(kind: RepoErrorKind, message: string, status?: number) {
    super(kind, message, status);
    this.name = 'GithubApiError';
  }
}

/**
 * Read-only GitHub access for Viby.
 *
 * The web client is ~125k lines — far too large to put in a prompt — so the
 * model pulls only what it needs through these methods. File contents are
 * always fetched live; the file *tree* is cached per commit SHA so a listing
 * costs one cheap call instead of a full re-download.
 *
 * Everything returned from here passes through `scrubSecrets()`: the web client
 * repo contains live Mapbox and TimeZoneDB tokens in plaintext, and this is the
 * boundary where they would otherwise reach OpenRouter and Telegram.
 */

const API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;
const TREE_CACHE_TTL_SECONDS = 3_600;
/**
 * A single file's diff. Sized from a real case: the commit that added the vibe
 * context menu changed its template by 9.8k characters, and the answer to "what
 * does it do" was the list of menu items near the end. A cap that clips that is
 * a cap that produces a confident, half-right answer.
 */
const MAX_PATCH_CHARS = 10_000;

const MAX_TREE_ENTRIES = 200;





// ---------------------------------------------------------------------------

export class GithubClient {
  private readonly byKey = new Map<string, RepoConfig>();

  constructor(
    private readonly token: string,
    private readonly store: Store,
    repos: RepoConfig[],
  ) {
    for (const repo of repos) this.byKey.set(repo.key, repo);
  }

  /** The repos Viby may read — used to build the prompt and validate tool calls. */
  listRepos(): RepoConfig[] {
    return [...this.byKey.values()];
  }

  resolveRepo(key: string): RepoConfig {
    const repo = this.byKey.get(key);
    if (!repo) {
      const known = [...this.byKey.keys()].join(', ');
      throw new GithubApiError('bad_request', `Unknown repo "${key}". Known repos: ${known}.`);
    }
    return repo;
  }

  resolveBranch(repo: RepoConfig, branch?: string): string {
    if (!branch) return repo.defaultBranch;
    if (!repo.branches.includes(branch)) {
      throw new GithubApiError(
        'bad_request',
        `Branch "${branch}" is not readable for ${repo.key}. Allowed: ${repo.branches.join(', ')}.`,
      );
    }
    return branch;
  }

  // ---- transport ----------------------------------------------------------

  private async request<T>(path: string, accept = 'application/vnd.github+json'): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'viby-bot',
        },
        signal: controller.signal,
      });
    } catch (err) {
      throw new GithubApiError(
        'network',
        err instanceof Error && err.name === 'AbortError'
          ? 'GitHub request timed out'
          : 'Could not reach GitHub',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) throw await this.toApiError(res);
    return (await res.json()) as T;
  }

  private async toApiError(res: Response): Promise<GithubApiError> {
    let serverMessage = '';
    try {
      const body = (await res.json()) as { message?: string };
      serverMessage = body.message ?? '';
    } catch {
      /* ignore non-JSON bodies */
    }
    switch (res.status) {
      case 401:
        return new GithubApiError('unauthorized', 'GitHub token is invalid or expired', 401);
      case 403:
        return /rate limit/i.test(serverMessage)
          ? new GithubApiError('rate_limited', 'GitHub API rate limit reached', 403)
          : new GithubApiError('forbidden', 'GitHub token lacks access to this repository', 403);
      case 404:
        return new GithubApiError('not_found', serverMessage || 'Not found on GitHub', 404);
      case 422:
        return new GithubApiError('bad_request', serverMessage || 'GitHub rejected the query', 422);
      case 429:
        return new GithubApiError('rate_limited', 'GitHub API rate limit reached', 429);
      default:
        return new GithubApiError('http', `GitHub error (HTTP ${res.status})`, res.status);
    }
  }

  // ---- tree ---------------------------------------------------------------

  private async getHeadSha(repo: RepoConfig, branch: string): Promise<string> {
    const data = await this.request<{ object?: { sha?: string } }>(
      `/repos/${repo.owner}/${repo.name}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const sha = data.object?.sha;
    if (!sha) throw new GithubApiError('not_found', `Branch "${branch}" has no head commit`);
    return sha;
  }

  /** Full file list for a branch, cached until the branch head moves. */
  async getTree(repoKey: string, branch?: string): Promise<TreeEntry[]> {
    const repo = this.resolveRepo(repoKey);
    const ref = this.resolveBranch(repo, branch);
    const head = await this.getHeadSha(repo, ref);
    const cacheKey = `viby:tree:${repo.owner}/${repo.name}:${ref}`;

    const cached = await this.store.getCached(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { sha: string; entries: TreeEntry[] };
        if (parsed.sha === head) return parsed.entries;
      } catch {
        /* fall through and refetch */
      }
    }

    const data = await this.request<{
      tree?: { path: string; type: string; size?: number }[];
    }>(`/repos/${repo.owner}/${repo.name}/git/trees/${head}?recursive=1`);

    const entries: TreeEntry[] = (data.tree ?? [])
      .filter((e) => e.type === 'blob' || e.type === 'tree')
      .map((e) => ({ path: e.path, type: e.type === 'tree' ? 'tree' : 'blob', size: e.size }));

    await this.store.setCached(
      cacheKey,
      JSON.stringify({ sha: head, entries }),
      TREE_CACHE_TTL_SECONDS,
    );
    return entries;
  }

  /** Files under a path prefix. Cheap — served from the cached tree. */
  async listTree(
    repoKey: string,
    branch: string | undefined,
    prefix = '',
    limit = MAX_TREE_ENTRIES,
    match?: string,
  ): Promise<{ entries: TreeEntry[]; total: number }> {
    const all = await this.getTree(repoKey, branch);
    const normalized = prefix.replace(/^\/+|\/+$/g, '');
    const matches = all
      .filter((e) => !deniedPathReason(e.path))
      .filter((e) =>
        normalized ? e.path === normalized || e.path.startsWith(`${normalized}/`) : true,
      )
      .filter((e) => (match ? pathMatchesQuery(e.path, match) : true));
    return { entries: matches.slice(0, Math.min(limit, MAX_TREE_ENTRIES)), total: matches.length };
  }

  // ---- file contents ------------------------------------------------------

  async readFile(
    repoKey: string,
    branch: string | undefined,
    path: string,
    startLine?: number,
    endLine?: number,
  ): Promise<FileSlice> {
    const repo = this.resolveRepo(repoKey);
    const ref = this.resolveBranch(repo, branch);
    const clean = path.replace(/^\/+/, '');

    const raw = await this.fetchFileText(repo, ref, clean);
    const lines = raw.split('\n');
    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(lines.length, endLine ?? from + MAX_FILE_LINES - 1);
    const cappedTo = Math.min(to, from + MAX_FILE_LINES - 1);

    let body = lines.slice(from - 1, cappedTo).join('\n');
    let truncated = cappedTo < lines.length || from > 1;
    if (body.length > MAX_FILE_CHARS) {
      body = body.slice(0, MAX_FILE_CHARS);
      truncated = true;
    }

    return {
      repo: repo.key,
      branch: ref,
      path: clean,
      startLine: from,
      endLine: cappedTo,
      totalLines: lines.length,
      truncated,
      content: scrubSecrets(body),
    };
  }

  /** Whole decoded file, denylist-checked. Shared by readFile and outlineFile. */
  private async fetchFileText(repo: RepoConfig, ref: string, clean: string): Promise<string> {
    const denied = deniedPathReason(clean);
    if (denied) throw new PathDeniedError(clean, denied);

    const data = await this.request<{ content?: string; encoding?: string; size?: number }>(
      `/repos/${repo.owner}/${repo.name}/contents/${clean
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?ref=${encodeURIComponent(ref)}`,
    );

    if (!data.content || data.encoding !== 'base64') {
      throw new GithubApiError('too_large', `"${clean}" is not a readable text file`);
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  /**
   * Declaration-only view of a file — classes, interfaces, methods, exported
   * members, Angular decorators and HTTP calls — each with its line number.
   *
   * This is the antidote to the web client's giant files: `core.component.ts`
   * is ~7,800 lines (~95k tokens) but outlines to roughly 2k, after which the
   * model can `read_file` the exact range it needs.
   */
  async outlineFile(
    repoKey: string,
    branch: string | undefined,
    path: string,
  ): Promise<{ repo: string; branch: string; path: string; totalLines: number; outline: string }> {
    const repo = this.resolveRepo(repoKey);
    const ref = this.resolveBranch(repo, branch);
    const clean = path.replace(/^\/+/, '');
    const raw = await this.fetchFileText(repo, ref, clean);
    const { totalLines, outline } = outlineOf(raw, clean);

    return {
      repo: repo.key,
      branch: ref,
      path: clean,
      totalLines,
      outline: scrubSecrets(outline),
    };
  }

  // ---- search -------------------------------------------------------------

  /**
   * GitHub code search.
   *
   * Two limits the caller must respect: it only indexes each repo's **default
   * branch** (`master-github` for the web client), so hits can trail `develop`
   * and must be re-read from the wanted ref; and it is capped at **10 requests
   * per minute** account-wide, so results are cached and `listTree` is
   * preferred for "where does X live".
   */
  async searchCode(repoKey: string, query: string, limit = 15): Promise<CodeHit[]> {
    const repo = this.resolveRepo(repoKey);
    const q = `${query} repo:${repo.owner}/${repo.name}`;
    const data = await this.request<{
      items?: { path: string; text_matches?: { fragment?: string }[] }[];
    }>(
      `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 15)}`,
      'application/vnd.github.text-match+json',
    );
    return (data.items ?? []).filter((item) => !deniedPathReason(item.path)).map((item) => ({
      path: item.path,
      fragments: (item.text_matches ?? [])
        .map((m) => scrubSecrets((m.fragment ?? '').trim()).slice(0, 300))
        .filter(Boolean)
        .slice(0, 2),
    }));
  }

  // ---- history ------------------------------------------------------------

  async recentCommits(repoKey: string, branch?: string, limit = 15): Promise<CommitInfo[]> {
    const repo = this.resolveRepo(repoKey);
    const ref = this.resolveBranch(repo, branch);
    const data = await this.request<
      {
        sha: string;
        commit?: { message?: string; author?: { name?: string; date?: string } };
      }[]
    >(
      `/repos/${repo.owner}/${repo.name}/commits?sha=${encodeURIComponent(ref)}&per_page=${Math.min(
        limit,
        15,
      )}`,
    );
    return data.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: (c.commit?.message ?? '').split('\n')[0].slice(0, 140),
      author: c.commit?.author?.name ?? 'unknown',
      date: c.commit?.author?.date ?? '',
    }));
  }

  /**
   * Files touched by one commit.
   *
   * This is what makes "what did we just ship?" answerable. GitHub's code
   * search only indexes each repo's default branch, so a feature merged to
   * `develop` is invisible to `searchCode` until it reaches production: the
   * search comes back empty and the honest-looking conclusion is "that feature
   * does not exist". Walking commits to their files avoids the index entirely.
   */
  async commitChanges(
    repoKey: string,
    sha: string,
    limit = 40,
    patchFor?: string,
  ): Promise<ChangeSet> {
    const repo = this.resolveRepo(repoKey);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      throw new GithubApiError('bad_request', `"${sha}" is not a commit sha.`);
    }
    const data = await this.request<{ files?: RawFile[] }>(
      `/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    );
    return toChangeSet(`commit ${sha.slice(0, 7)}`, data.files, limit, patchFor);
  }

  /** What differs between two refs — e.g. what is on develop but not production. */
  async compareRefs(
    repoKey: string,
    base: string,
    head: string,
    limit = 60,
    patchFor?: string,
  ): Promise<ChangeSet> {
    const repo = this.resolveRepo(repoKey);
    const from = this.resolveBranch(repo, base);
    const to = this.resolveBranch(repo, head);
    const data = await this.request<{ ahead_by?: number; files?: RawFile[] }>(
      `/repos/${repo.owner}/${repo.name}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`,
    );
    const set = toChangeSet(`${from}...${to}`, data.files, limit, patchFor);
    set.aheadBy = data.ahead_by ?? 0;
    set.combined = true;
    return set;
  }
}

interface RawFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

/** Say so when a diff is clipped — silence there reads as "that was all of it". */
function truncatePatch(patch: string): string {
  if (patch.length <= MAX_PATCH_CHARS) return patch;
  const dropped = patch.length - MAX_PATCH_CHARS;
  return `${patch.slice(0, MAX_PATCH_CHARS)}
[diff truncated — ${dropped} more characters. You have seen only the start of this change.]`;
}

/**
 * Shared shaping for both change views, with the path denylist applied.
 *
 * `patchFor` narrows the set to one file and carries its diff. Knowing that a
 * template grew by 121 lines is useless on its own — the model then has to read
 * a 3,000-line file blind and usually runs out of budget first. The diff is the
 * answer, and it is a fraction of the size.
 */
function toChangeSet(
  label: string,
  raw: RawFile[] | undefined,
  limit: number,
  patchFor?: string,
): ChangeSet {
  const all = (raw ?? []).filter((f) => f.filename && !deniedPathReason(f.filename));
  const wanted = patchFor ? all.filter((f) => f.filename === patchFor) : all;
  return {
    label,
    totalFiles: all.length,
    files: wanted.slice(0, patchFor ? 1 : limit).map((f) => ({
      path: f.filename as string,
      status: f.status ?? 'modified',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      // Diffs are file contents like any other: scrub before they leave here.
      patch: patchFor ? truncatePatch(scrubSecrets(f.patch ?? '')) : undefined,
    })),
  };
}
