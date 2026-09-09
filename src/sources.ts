import { AzureClient } from './azure';
import type { RepoConfig } from './config';
import { GithubClient } from './github';
import type { ChangeSet, CodeHit, CommitInfo, FileSlice, TreeEntry } from './repo-read';
import { RepoApiError } from './repo-read';

/**
 * One front door for every repository Viby can read.
 *
 * The tool layer asks for `webclient` or `wiki` and gets the same shapes back
 * either way; which API answered is this file's problem alone. That is what
 * keeps `tools.ts` from sprouting a branch per provider, and what makes adding
 * a fourth repo a line of config rather than a change to the agent.
 *
 * Sources with no credentials configured are simply absent: their repos are
 * never registered, so the model is never told about a repo it cannot open.
 */

/** The surface every source client implements. */
export interface RepoSource {
  listRepos(): RepoConfig[];
  listTree(
    repoKey: string,
    branch: string | undefined,
    prefix?: string,
    limit?: number,
    match?: string,
  ): Promise<{ entries: TreeEntry[]; total: number }>;
  readFile(
    repoKey: string,
    branch: string | undefined,
    path: string,
    startLine?: number,
    endLine?: number,
  ): Promise<FileSlice>;
  outlineFile(
    repoKey: string,
    branch: string | undefined,
    path: string,
  ): Promise<{ repo: string; branch: string; path: string; totalLines: number; outline: string }>;
  searchCode(repoKey: string, query: string, limit?: number): Promise<CodeHit[]>;
  recentCommits(repoKey: string, branch?: string, limit?: number): Promise<CommitInfo[]>;
  commitChanges(repoKey: string, sha: string, limit?: number, patchFor?: string): Promise<ChangeSet>;
  compareRefs(
    repoKey: string,
    base: string,
    head: string,
    limit?: number,
    patchFor?: string,
  ): Promise<ChangeSet>;
}

export class Sources implements RepoSource {
  private readonly byKey = new Map<string, RepoSource>();
  private readonly repos: RepoConfig[] = [];

  constructor(clients: (GithubClient | AzureClient | undefined)[]) {
    for (const client of clients) {
      if (!client) continue;
      for (const repo of client.listRepos()) {
        this.byKey.set(repo.key, client);
        this.repos.push(repo);
      }
    }
  }

  listRepos(): RepoConfig[] {
    return [...this.repos];
  }

  private route(repoKey: string): RepoSource {
    const client = this.byKey.get(repoKey);
    if (!client) {
      const known = [...this.byKey.keys()].join(', ');
      throw new RepoApiError('bad_request', `Unknown repo "${repoKey}". Known repos: ${known}.`);
    }
    return client;
  }

  listTree(
    repoKey: string,
    branch: string | undefined,
    prefix?: string,
    limit?: number,
    match?: string,
  ): Promise<{ entries: TreeEntry[]; total: number }> {
    return this.route(repoKey).listTree(repoKey, branch, prefix, limit, match);
  }

  readFile(
    repoKey: string,
    branch: string | undefined,
    path: string,
    startLine?: number,
    endLine?: number,
  ): Promise<FileSlice> {
    return this.route(repoKey).readFile(repoKey, branch, path, startLine, endLine);
  }

  outlineFile(
    repoKey: string,
    branch: string | undefined,
    path: string,
  ): Promise<{ repo: string; branch: string; path: string; totalLines: number; outline: string }> {
    return this.route(repoKey).outlineFile(repoKey, branch, path);
  }

  searchCode(repoKey: string, query: string, limit?: number): Promise<CodeHit[]> {
    return this.route(repoKey).searchCode(repoKey, query, limit);
  }

  recentCommits(repoKey: string, branch?: string, limit?: number): Promise<CommitInfo[]> {
    return this.route(repoKey).recentCommits(repoKey, branch, limit);
  }

  commitChanges(
    repoKey: string,
    sha: string,
    limit?: number,
    patchFor?: string,
  ): Promise<ChangeSet> {
    return this.route(repoKey).commitChanges(repoKey, sha, limit, patchFor);
  }

  compareRefs(
    repoKey: string,
    base: string,
    head: string,
    limit?: number,
    patchFor?: string,
  ): Promise<ChangeSet> {
    return this.route(repoKey).compareRefs(repoKey, base, head, limit, patchFor);
  }
}
