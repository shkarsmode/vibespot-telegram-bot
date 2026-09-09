import type { RepoConfig } from './config';
import {
  type ChangeSet,
  type CodeHit,
  type CommitInfo,
  type FileSlice,
  type TreeEntry,
  deniedPathReason,
  MAX_FILE_CHARS,
  MAX_FILE_LINES,
  outlineOf,
  PathDeniedError,
  RepoApiError,
  scrubSecrets,
} from './repo-read';
import type { Store } from './store';

/**
 * Read-only Azure DevOps access, for the repos that do not live on GitHub: the
 * React Native mobile client and the team wiki.
 *
 * Same contract as the GitHub client, so the tool layer never learns which
 * source a repo came from — and the same caps and secret scrubbing, because
 * those live in repo-read.ts rather than in either client.
 *
 * Two differences are real and are surfaced rather than papered over: Azure
 * exposes no per-file patch (only which paths a commit touched), and its code
 * search needs a separate service, so `searchCode` says so instead of quietly
 * returning nothing — an empty search result is exactly what once had Viby
 * declaring a shipped feature missing.
 */

const API_VERSION = '7.1';
const REQUEST_TIMEOUT_MS = 15_000;
const TREE_CACHE_TTL_SECONDS = 3_600;
const MAX_TREE_ENTRIES = 200;

interface AzureItem {
  path?: string;
  isFolder?: boolean;
  gitObjectType?: string;
  size?: number;
}

interface AzureChange {
  item?: { path?: string; isFolder?: boolean };
  changeType?: string;
}

export class AzureClient {
  private readonly byKey = new Map<string, RepoConfig>();
  private readonly auth: string;

  constructor(
    pat: string,
    private readonly store: Store,
    repos: RepoConfig[],
  ) {
    // Azure DevOps takes a PAT as HTTP Basic with an empty username.
    this.auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    for (const repo of repos) this.byKey.set(repo.key, repo);
  }

  listRepos(): RepoConfig[] {
    return [...this.byKey.values()];
  }

  resolveRepo(key: string): RepoConfig {
    const repo = this.byKey.get(key);
    if (!repo) throw new RepoApiError('bad_request', `Unknown repo "${key}".`);
    return repo;
  }

  resolveBranch(repo: RepoConfig, branch?: string): string {
    if (!branch) return repo.defaultBranch;
    if (!repo.branches.includes(branch)) {
      throw new RepoApiError(
        'bad_request',
        `Branch "${branch}" is not readable for ${repo.key}. Allowed: ${repo.branches.join(', ')}.`,
      );
    }
    return branch;
  }

  // ---- tree ---------------------------------------------------------------

  private async getHeadSha(repo: RepoConfig, branch: string): Promise<string> {
    const data = await this.request<{ value?: { objectId?: string }[] }>(
      repo,
      `/refs?filter=heads/${encodeURIComponent(branch)}&api-version=${API_VERSION}`,
    );
    const sha = data.value?.[0]?.objectId;
    if (!sha) throw new RepoApiError('not_found', `Branch "${branch}" has no head commit`);
    return sha;
  }

  /** Full file list for a branch, cached until the branch head moves. */
  async getTree(repoKey: string, branch?: string): Promise<TreeEntry[]> {
    const repo = this.resolveRepo(repoKey);
    const ref = this.resolveBranch(repo, branch);
    const head = await this.getHeadSha(repo, ref);
    const cacheKey = `viby:tree:az:${repo.key}:${ref}`;

    const cached = await this.store.getCached(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { sha: string; entries: TreeEntry[] };
        if (parsed.sha === head) return parsed.entries;
      } catch {
        /* fall through and refetch */
      }
    }

    const data = await this.request<{ value?: AzureItem[] }>(
      repo,
      `/items?scopePath=/&recursionLevel=Full&versionDescriptor.version=${encodeURIComponent(ref)}` +
        `&versionDescriptor.versionType=branch&api-version=${API_VERSION}`,
    );
    const entries: TreeEntry[] = (data.value ?? [])
      .filter((i) => i.path && i.path !== '/')
      .map((i) => ({
        // Azure paths are absolute ("/src/App.tsx"); GitHub's are not. Everything
        // downstream — and every path Viby quotes — stays in GitHub's shape.
        path: (i.path as string).replace(/^\/+/, ''),
        type: i.isFolder || i.gitObjectType === 'tree' ? ('tree' as const) : ('blob' as const),
        size: i.size,
      }))
      .filter((e) => !deniedPathReason(e.path));

    await this.store.setCached(
      cacheKey,
      JSON.stringify({ sha: head, entries }),
      TREE_CACHE_TTL_SECONDS,
    );
    return entries;
  }

  async listTree(
    repoKey: string,
    branch: string | undefined,
    prefix = '',
    limit = MAX_TREE_ENTRIES,
  ): Promise<{ entries: TreeEntry[]; total: number }> {
    const all = await this.getTree(repoKey, branch);
    const clean = prefix.replace(/^\/+/, '');
    const matched = all.filter((e) => (clean ? e.path.startsWith(clean) : true));
    return {
      entries: matched.slice(0, Math.min(limit, MAX_TREE_ENTRIES)),
      total: matched.length,
    };
  }

  // ---- file content -------------------------------------------------------

  private async fetchFileText(repo: RepoConfig, ref: string, path: string): Promise<string> {
    const reason = deniedPathReason(path);
    if (reason) throw new PathDeniedError(path, reason);

    const data = await this.request<{ content?: string }>(
      repo,
      `/items?path=/${encodeURIComponent(path)}&includeContent=true` +
        `&versionDescriptor.version=${encodeURIComponent(ref)}` +
        `&versionDescriptor.versionType=branch&api-version=${API_VERSION}`,
    );
    if (typeof data.content !== 'string') {
      throw new RepoApiError('too_large', 'Not a readable text file');
    }
    return data.content;
  }

  async readFile(
    repoKey: string,
    branch: string | undefined,
    path: string,
    startLine = 1,
    endLine?: number,
  ): Promise<FileSlice> {
    const repo = this.resolveRepo(repoKey);
    const ref = this.resolveBranch(repo, branch);
    const clean = path.replace(/^\/+/, '');
    const raw = await this.fetchFileText(repo, ref, clean);
    const lines = raw.split('\n');

    const from = Math.max(1, startLine);
    const to = Math.min(lines.length, endLine ?? from + MAX_FILE_LINES - 1);
    const cappedTo = Math.min(to, from + MAX_FILE_LINES - 1);

    let body = lines.slice(from - 1, cappedTo).join('\n');
    let truncated = cappedTo < lines.length;
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
    return { repo: repo.key, branch: ref, path: clean, totalLines, outline: scrubSecrets(outline) };
  }

  /** Azure code search is a separate service; say so rather than return nothing. */
  async searchCode(repoKey: string, _query: string, _limit = 15): Promise<CodeHit[]> {
    const repo = this.resolveRepo(repoKey);
    throw new RepoApiError(
      'bad_request',
      `Full-text search is not available for ${repo.key} (Azure DevOps). ` +
        'Use list_files to locate the file, then outline_file or read_file.',
    );
  }

  // ---- history ------------------------------------------------------------

  async recentCommits(repoKey: string, branch?: string, limit = 15): Promise<CommitInfo[]> {
    const repo = this.resolveRepo(repoKey);
    const ref = this.resolveBranch(repo, branch);
    const data = await this.request<{
      value?: { commitId?: string; comment?: string; author?: { name?: string; date?: string } }[];
    }>(
      repo,
      `/commits?searchCriteria.itemVersion.version=${encodeURIComponent(ref)}` +
        `&searchCriteria.itemVersion.versionType=branch&searchCriteria.$top=${Math.min(limit, 15)}` +
        `&api-version=${API_VERSION}`,
    );
    return (data.value ?? []).map((c) => ({
      sha: (c.commitId ?? '').slice(0, 7),
      message: (c.comment ?? '').split('\n')[0].slice(0, 140),
      author: c.author?.name ?? 'unknown',
      date: c.author?.date ?? '',
    }));
  }

  async commitChanges(
    repoKey: string,
    sha: string,
    limit = 40,
    patchFor?: string,
  ): Promise<ChangeSet> {
    const repo = this.resolveRepo(repoKey);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      throw new RepoApiError('bad_request', `"${sha}" is not a commit sha.`);
    }
    const data = await this.request<{ changes?: AzureChange[] }>(
      repo,
      `/commits/${sha}/changes?api-version=${API_VERSION}`,
    );
    return this.toChangeSet(`commit ${sha.slice(0, 7)}`, data.changes, limit, patchFor);
  }

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
    const data = await this.request<{ aheadCount?: number; changes?: AzureChange[] }>(
      repo,
      `/diffs/commits?baseVersion=${encodeURIComponent(from)}&baseVersionType=branch` +
        `&targetVersion=${encodeURIComponent(to)}&targetVersionType=branch` +
        `&api-version=${API_VERSION}`,
    );
    const set = this.toChangeSet(`${from}...${to}`, data.changes, limit, patchFor);
    set.aheadBy = data.aheadCount ?? 0;
    set.combined = true;
    return set;
  }

  /**
   * Azure reports which paths changed but never the patch, so a request for one
   * can only be answered with the truth: read the file instead. Saying that
   * beats an empty diff, which the model would read as "nothing changed here".
   */
  private toChangeSet(
    label: string,
    raw: AzureChange[] | undefined,
    limit: number,
    patchFor?: string,
  ): ChangeSet {
    const all = (raw ?? [])
      .filter((c) => c.item?.path && !c.item.isFolder)
      .map((c) => ({
        path: (c.item?.path as string).replace(/^\/+/, ''),
        status: (c.changeType ?? 'edit').toLowerCase(),
        additions: 0,
        deletions: 0,
      }))
      .filter((f) => !deniedPathReason(f.path));

    const wanted = patchFor ? all.filter((f) => f.path === patchFor) : all;
    return {
      label,
      totalFiles: all.length,
      files: wanted.slice(0, patchFor ? 1 : limit).map((f) => ({
        ...f,
        patch: patchFor
          ? 'Azure DevOps does not expose a diff for a file. Call read_file on this path instead.'
          : undefined,
      })),
    };
  }

  // ---- transport ----------------------------------------------------------

  private async request<T>(repo: RepoConfig, path: string): Promise<T> {
    const base =
      `https://dev.azure.com/${repo.organization}/${encodeURIComponent(repo.owner)}` +
      `/_apis/git/repositories/${encodeURIComponent(repo.name)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        headers: { Authorization: this.auth, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      throw new RepoApiError(
        'network',
        err instanceof Error && err.name === 'AbortError'
          ? 'Azure DevOps request timed out'
          : 'Could not reach Azure DevOps',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      switch (res.status) {
        case 401:
          throw new RepoApiError('unauthorized', 'Azure DevOps token is invalid or expired', 401);
        case 403:
          throw new RepoApiError('forbidden', 'Azure DevOps token lacks Code (Read)', 403);
        case 404:
          throw new RepoApiError('not_found', 'Not found on that branch', 404);
        default:
          throw new RepoApiError('http', `Azure DevOps error (HTTP ${res.status})`, res.status);
      }
    }

    // A PAT that cannot see the project is answered with an HTML sign-in page
    // and HTTP 200 — the one failure that would otherwise look like success.
    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      throw new RepoApiError('unauthorized', 'Azure DevOps returned a sign-in page, not data');
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RepoApiError('http', 'Azure DevOps returned a non-JSON response', res.status);
    }
  }
}
