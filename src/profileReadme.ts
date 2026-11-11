import type { Octokit } from '@octokit/rest';

import {
  PRODUCTIVE_BOX_END_MARKER,
  PRODUCTIVE_BOX_START_MARKER,
  type RenderedDashboard,
} from './dashboardRenderer.js';

// Builds the updated README; the caller commits it together with the cache files.
export async function updateProfileReadme(
  octokit: Octokit,
  renderDashboard: (currentStatus: string) => RenderedDashboard,
): Promise<{ status: string; content: string } | undefined> {
  const owner = 'laiflonglearner';
  const repo = 'laiflonglearner';
  const path = 'README.md';
  const readme = await octokit.repos
    .getContent({ owner, repo, path })
    .catch((error) => {
      console.error(`Unable to get profile README\n${error}`);
      return undefined;
    });

  if (!readme || Array.isArray(readme.data) || !('content' in readme.data)) {
    console.error('Unable to read profile README');
    return undefined;
  }

  const currentReadme = Buffer.from(readme.data.content, 'base64').toString('utf8');
  const startIndex = currentReadme.indexOf(PRODUCTIVE_BOX_START_MARKER);
  const endIndex = currentReadme.indexOf(PRODUCTIVE_BOX_END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    console.error('Productive box markers not found in README');
    return undefined;
  }

  const currentBlock = currentReadme.slice(
    startIndex,
    endIndex + PRODUCTIVE_BOX_END_MARKER.length,
  );
  const currentStatusMatch = currentBlock.match(/^### (.+)$/m);
  const currentStatus = currentStatusMatch?.[1] ?? '';
  const rendered = renderDashboard(currentStatus);
  const updatedReadme =
    currentReadme.slice(0, startIndex) +
    rendered.block +
    currentReadme.slice(endIndex + PRODUCTIVE_BOX_END_MARKER.length);

  return { status: rendered.status, content: updatedReadme };
}
