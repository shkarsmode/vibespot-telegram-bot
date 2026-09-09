import type { ProjectConfig } from '../config';
import { buildDeploymentsReport } from '../commands/deployments';
import {
  GithubApiError,
  GithubClient,
  MAX_FILE_LINES,
  PathDeniedError,
} from '../github';
import type { VercelClient } from '../vercel';
import type { ToolSchema } from './openrouter';
import type { EffortProfile } from './models';

/**
 * The tool surface Viby uses to answer questions.
 *
 * Deliberately small — every schema is re-sent on every iteration, so five
 * tools cost roughly 700 tokens per round. Each result is capped and counted
 * against the effort profile's character budget so one question can never run
 * away with the context (or the bill).
 */

export interface ToolContext {
  github: GithubClient;
  vercel: VercelClient;
  projects: ProjectConfig[];
  profile: EffortProfile;
  /** Mutable running total of tool-output characters for this question. */
  charsUsed: { value: number };
}

export function buildToolSchemas(github: GithubClient): ToolSchema[] {
  const repos = github.listRepos();
  const repoEnum = repos.map((r) => r.key);
  const branchEnum = [...new Set(repos.flatMap((r) => r.branches))];
  const repoDescription = repos
    .map((r) => `${r.key} = ${r.owner}/${r.name} (${r.summary} Branches: ${r.branches.join(', ')}; default ${r.defaultBranch})`)
    .join(' | ');

  const repoParam = { type: 'string', enum: repoEnum, description: repoDescription };
  const refParam = {
    type: 'string',
    enum: branchEnum,
    description:
      'Branch to read. Defaults to the repo default (develop for the web client). Use master-github only for questions about what is live in production.',
  };

  return [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description:
          'List file paths in a repo under a path prefix. Free and fast (served from a cached git tree) — ALWAYS prefer this over search_code to find where something lives. Secret, binary and lockfile paths are excluded.',
        parameters: {
          type: 'object',
          properties: {
            repo: repoParam,
            ref: refParam,
            path_prefix: {
              type: 'string',
              description: 'e.g. "src/app/shared/services" or "docs". Omit for the repo root.',
            },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
          },
          required: ['repo'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'outline_file',
        description:
          'Return only the declarations of a file (classes, interfaces, methods, decorators, HTTP calls) with line numbers. Use this FIRST on any file you have not read — several files exceed 1,500 lines and core.component.ts is ~7,800. Then read_file the exact range you need.',
        parameters: {
          type: 'object',
          properties: { repo: repoParam, ref: refParam, path: { type: 'string' } },
          required: ['repo', 'path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read a line range of a file. Output is capped, so request a window rather than a whole file. Secrets are redacted and some paths are blocked outright.',
        parameters: {
          type: 'object',
          properties: {
            repo: repoParam,
            ref: refParam,
            path: { type: 'string' },
            start_line: { type: 'integer', minimum: 1, default: 1 },
            max_lines: {
              type: 'integer',
              minimum: 10,
              maximum: MAX_FILE_LINES,
              description: 'Clamped by the current effort setting.',
            },
          },
          required: ['repo', 'path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_code',
        description:
          'Full-text code search. IMPORTANT: GitHub only indexes each repo default branch (master-github for the web client), so hits can be stale relative to develop — confirm with read_file on the branch you care about. Rate limited; prefer list_files + outline_file.',
        parameters: {
          type: 'object',
          properties: {
            repo: repoParam,
            query: {
              type: 'string',
              description: 'Literal text or symbol, e.g. "shouldShowMarker" or "vibes/filter".',
            },
            limit: { type: 'integer', minimum: 1, maximum: 15, default: 8 },
          },
          required: ['repo', 'query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'changed_files',
        description:
          'What a change touched. TO LEARN WHAT A FEATURE DOES: recent_commits -> pick the commit whose message names it -> changed_files with that `commit` + `path` to read its diff. Never use `base`/`head` for that — a branch range merges dozens of commits into one diff too big to read. Pass `commit` (a sha from recent_commits) for the files that commit changed — for anything recent this is the ONLY reliable route, because search_code cannot see work that has not reached the default branch. Pass `base` + `head` (e.g. base master-github, head develop) to see what is not on production yet. Then pass `path` as well to get the ACTUAL DIFF for that one file — do this instead of read_file when you want to know what a change does; the diff is the new code, and it is far smaller than the file.',
        parameters: {
          type: 'object',
          properties: {
            repo: repoParam,
            commit: { type: 'string', description: 'Commit sha from recent_commits.' },
            path: {
              type: 'string',
              description:
                'A path from a previous changed_files result. Returns the diff for that file instead of the file list. For "what does this feature do", the template (.html) diff usually answers it better than the .ts.',
            },
            base: { ...refParam, description: 'Compare mode: the ref to compare FROM.' },
            head: { ...refParam, description: 'Compare mode: the ref to compare TO.' },
            limit: { type: 'integer', minimum: 1, maximum: 60, default: 40 },
          },
          required: ['repo'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_deployments',
        description:
          'Current production deployment status for Landing, Web Client and API/AI: state, branch, commit, age and failure reason.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ];
}

/** Telegram HTML -> plain text, so tool output does not waste tokens on markup. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function friendlyToolError(err: unknown): string {
  if (err instanceof PathDeniedError) {
    return `BLOCKED: ${err.message} Describe its role from the docs instead, or ask the user directly.`;
  }
  if (err instanceof GithubApiError) {
    switch (err.kind) {
      case 'not_found':
        return 'ERROR: not found on that branch. Use list_files to check the exact path.';
      case 'rate_limited':
        return 'ERROR: GitHub rate limit hit. Use list_files and outline_file instead of search_code.';
      case 'unauthorized':
      case 'forbidden':
        return 'ERROR: no GitHub access to that repository.';
      case 'too_large':
        return 'ERROR: not a readable text file.';
      default:
        return `ERROR: ${err.message}`;
    }
  }
  return 'ERROR: the tool failed unexpectedly. Try a different approach.';
}

/**
 * Run one tool call. Never throws — every failure becomes a short `ERROR: …`
 * string so the model can recover instead of the whole answer dying.
 */
export async function dispatchTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<string> {
  if (ctx.charsUsed.value >= ctx.profile.toolCharBudget) {
    return 'ERROR: retrieval budget exhausted for this question. Answer with what you already have, and say what you could not verify.';
  }

  let args: Record<string, unknown>;
  try {
    args = rawArguments ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
  } catch {
    return 'ERROR: arguments were not valid JSON. Retry with a valid JSON object.';
  }

  let result: string;
  try {
    result = await runTool(name, args, ctx);
  } catch (err) {
    result = friendlyToolError(err);
  }

  ctx.charsUsed.value += result.length;
  return result;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const repo = typeof args.repo === 'string' ? args.repo : '';
  const ref = typeof args.ref === 'string' ? args.ref : undefined;

  switch (name) {
    case 'list_files': {
      const prefix = typeof args.path_prefix === 'string' ? args.path_prefix : '';
      const limit = typeof args.limit === 'number' ? args.limit : 100;
      const { entries, total } = await ctx.github.listTree(repo, ref, prefix, limit);
      if (!entries.length) return `No files under "${prefix || '/'}" in ${repo}.`;
      const shown = entries
        .filter((e) => e.type === 'blob')
        .map((e) => `${e.path}${e.size ? ` (${Math.round(e.size / 1024)}kb)` : ''}`)
        .join('\n');
      const more = total > entries.length ? `\n… ${total - entries.length} more, narrow the prefix.` : '';
      return `${repo} — files under "${prefix || '/'}":\n${shown}${more}`;
    }

    case 'outline_file': {
      const path = typeof args.path === 'string' ? args.path : '';
      const out = await ctx.github.outlineFile(repo, ref, path);
      if (!out.outline.trim()) {
        return `${out.repo}@${out.branch} ${out.path} (${out.totalLines} lines) — no declarations matched; read_file a range instead.`;
      }
      return `${out.repo}@${out.branch} ${out.path} — outline (${out.totalLines} lines total):\n${out.outline}`;
    }

    case 'read_file': {
      const path = typeof args.path === 'string' ? args.path : '';
      const start = typeof args.start_line === 'number' ? args.start_line : 1;
      const requested = typeof args.max_lines === 'number' ? args.max_lines : ctx.profile.defaultReadLines;
      const span = Math.min(requested, ctx.profile.maxReadLines, MAX_FILE_LINES);
      const slice = await ctx.github.readFile(repo, ref, path, start, start + span - 1);
      const numbered = slice.content
        .split('\n')
        .map((line, i) => `${slice.startLine + i}| ${line}`)
        .join('\n');
      const tail =
        slice.endLine < slice.totalLines
          ? `\n[cut at line ${slice.endLine} of ${slice.totalLines} — call read_file again with start_line: ${slice.endLine + 1}]`
          : '';
      return `${slice.repo}@${slice.branch} ${slice.path} (lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines})\n${numbered}${tail}`;
    }

    case 'changed_files': {
      const limit = typeof args.limit === 'number' ? args.limit : 40;
      const commit = typeof args.commit === 'string' ? args.commit.trim() : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const wantPatch = typeof args.path === 'string' ? args.path.trim() : '';

      let set;
      if (commit) {
        set = await ctx.github.commitChanges(repo, commit, limit, wantPatch || undefined);
      } else if (base && head) {
        set = await ctx.github.compareRefs(repo, base, head, limit, wantPatch || undefined);
      } else {
        return 'ERROR: pass either `commit`, or both `base` and `head`.';
      }

      if (wantPatch) {
        const file = set.files[0];
        if (!file) return `"${wantPatch}" is not among the files changed by ${set.label}.`;
        // A branch range squashes dozens of commits into one diff. Truncating it
        // yields a confident answer drawn from whichever change happened to come
        // first in the file — so refuse, and name the route that works.
        if (set.combined && file.patch && file.patch.includes('[diff truncated')) {
          return (
            `The diff of ${file.path} across ${set.label} spans ${set.aheadBy} commits and is far ` +
            `too large to read. Do NOT use a branch range to learn what one feature does. ` +
            `Call recent_commits, pick the commit whose message names the feature, then call ` +
            `changed_files with that commit AND this path.`
          );
        }
        if (!file.patch) return `${file.path} changed in ${set.label}, but GitHub returned no diff for it (usually too large or binary).`;
        return `${repo} — diff of ${file.path} in ${set.label} (+${file.additions} -${file.deletions}):\n${file.patch}`;
      }

      if (!set.totalFiles) return `${repo} — ${set.label} touched no readable files.`;
      const ahead =
        set.aheadBy !== undefined ? ` — ${set.aheadBy} commit${set.aheadBy === 1 ? '' : 's'} ahead` : '';
      const rows = set.files
        .map((f) => `${f.status[0].toUpperCase()} ${f.path} (+${f.additions} -${f.deletions})`)
        .join('\n');
      const more =
        set.totalFiles > set.files.length ? `\n… ${set.totalFiles - set.files.length} more files.` : '';
      return `${repo} — ${set.label}${ahead}, ${set.totalFiles} files:\n${rows}${more}`;
    }

    case 'search_code': {
      const query = typeof args.query === 'string' ? args.query : '';
      const limit = typeof args.limit === 'number' ? args.limit : 8;
      const hits = await ctx.github.searchCode(repo, query, limit);
      if (!hits.length) {
        // The model read the old wording as proof of absence and told the user
        // the feature did not exist — while it sat on develop, 27 commits ahead
        // of the only branch GitHub indexes.
        return (
          `No matches for "${query}" in ${repo}. NOTE: GitHub only indexes the default branch, ` +
          `so this proves NOTHING about develop — anything merged there but not yet shipped to ` +
          `production is invisible here. Do not conclude the feature is missing. Use ` +
          `recent_commits + changed_files, or list_files, to check the branch you actually care about.`
        );
      }
      return `${repo} — matches for "${query}" (default branch; confirm on the branch you need):\n${hits
        .map((h) => `${h.path}${h.fragments.length ? `\n    ${h.fragments.join('\n    ')}` : ''}`)
        .join('\n')}`;
    }

    case 'get_deployments': {
      const report = await buildDeploymentsReport(ctx.vercel, ctx.projects);
      return stripHtml(report);
    }

    default:
      return `ERROR: unknown tool "${name}". Available: list_files, outline_file, read_file, search_code, get_deployments.`;
  }
}
