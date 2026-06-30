import type { ProjectConfig } from '../config';
import { asHttpUrl, escapeHtml, link, timeAgo } from '../format';
import {
  NormalizedDeployment,
  VercelApiError,
  VercelClient,
} from '../vercel';

/** Map a deployment state (+target) to an emoji badge + label. */
function statusBadge(d: NormalizedDeployment): string {
  switch (d.state) {
    case 'READY':
      return d.target === 'production' ? '🟢 Production ready' : '🟢 Ready';
    case 'ERROR':
      return '🔴 Failed';
    case 'BUILDING':
      return '🟡 Building';
    case 'QUEUED':
      return '🟡 Queued';
    case 'INITIALIZING':
      return '🟡 Initializing';
    case 'CANCELED':
      return '⚪ Canceled';
    default:
      return '⚪ Unknown';
  }
}

/** Label for the timestamp line, which depends on the deployment state. */
function timeLabel(state: NormalizedDeployment['state']): string {
  if (state === 'ERROR') return 'Failed';
  if (state === 'BUILDING' || state === 'QUEUED' || state === 'INITIALIZING') {
    return 'Started';
  }
  return 'Deployed';
}

/** Friendly, token-free explanation for a failed Vercel call. */
function friendlyVercelError(err: unknown): string {
  if (err instanceof VercelApiError) {
    switch (err.kind) {
      case 'unauthorized':
        return 'Vercel token is invalid or expired.';
      case 'forbidden':
        return 'Vercel token has no access to this team/project.';
      case 'not_found':
        return 'Project or team not found on Vercel.';
      case 'rate_limited':
        return 'Vercel API rate limit reached — try again shortly.';
      case 'network':
        return 'Could not reach the Vercel API.';
      default:
        return 'Vercel API error.';
    }
  }
  return 'Unexpected error while loading this project.';
}

/** Build the "Domain:" line: custom domain if set, else the deployment URL. */
function domainLine(project: ProjectConfig, d: NormalizedDeployment): string {
  if (project.productionDomain) {
    const url = asHttpUrl(project.productionDomain);
    if (url) return `Domain: ${link(project.productionDomain, url)}`;
  }
  if (d.deploymentUrl) {
    const host = d.deploymentUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `Domain: ${link(host, d.deploymentUrl)}`;
  }
  return 'Domain: unavailable';
}

function deploymentSection(project: ProjectConfig, d: NormalizedDeployment, reason?: string): string {
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(project.label)}</b>`);
  lines.push(statusBadge(d));
  lines.push(domainLine(project, d));

  lines.push(
    d.inspectorUrl
      ? `Deploy: ${link('Open Vercel deployment', d.inspectorUrl)}`
      : 'Deploy: unavailable',
  );

  if (d.commitShort) {
    const message = d.commitMessage ? ` — ${escapeHtml(d.commitMessage)}` : '';
    lines.push(`Commit: <code>${escapeHtml(d.commitShort)}</code>${message}`);
  } else {
    lines.push('Commit: unavailable');
  }

  lines.push(d.commitUrl ? `GitHub: ${link('Open commit', d.commitUrl)}` : 'GitHub: unavailable');

  if (d.branch) lines.push(`Branch: ${escapeHtml(d.branch)}`);
  lines.push(`${timeLabel(d.state)}: ${timeAgo(d.timestamp)}`);
  if (d.author) lines.push(`By: ${escapeHtml(d.author)}`);

  if (d.state === 'ERROR') {
    lines.push(`Reason: ${escapeHtml(reason || 'Build failed')}`);
  }

  return lines.join('\n');
}

async function loadProjectSection(
  client: VercelClient,
  project: ProjectConfig,
): Promise<string> {
  try {
    const deployment = await client.getLatestProductionDeployment(project.projectId);
    if (!deployment) {
      return `<b>${escapeHtml(project.label)}</b>\n⚪ No production deployment found`;
    }
    let reason: string | undefined;
    if (deployment.state === 'ERROR') {
      reason = await client.getDeploymentErrorReason(deployment.id);
    }
    return deploymentSection(project, deployment, reason);
  } catch (err) {
    return `<b>${escapeHtml(project.label)}</b>\n⚠️ ${escapeHtml(friendlyVercelError(err))}`;
  }
}

/**
 * Build the full /deployments report. Each project is loaded independently so
 * one failing project never blocks the others — allSettled keeps that isolation
 * structural even if a section builder unexpectedly throws.
 */
export async function buildDeploymentsReport(
  client: VercelClient,
  projects: ProjectConfig[],
): Promise<string> {
  const settled = await Promise.allSettled(
    projects.map((project) => loadProjectSection(client, project)),
  );
  const sections = settled.map((result, i) =>
    result.status === 'fulfilled'
      ? result.value
      : `<b>${escapeHtml(projects[i].label)}</b>\n⚠️ Unexpected error while loading this project.`,
  );
  return ['🚀 <b>Vibespot deployments</b>', ...sections].join('\n\n');
}
