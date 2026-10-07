import { pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import { config } from 'dotenv';

import {
  fetchCommittedDates,
  fetchContributedRepos,
  type CommitInfo,
} from './fetchPaginated.js';
import { renderDashboardBlock } from './dashboardRenderer.js';
import {
  getDashboardStats,
  getTimeActivity,
  type IRepo,
  type IRepoActivity,
} from './dashboardStats.js';
import { loadCache, saveCache } from './githubCache.js';
import githubQuery from './githubQuery.js';
import { fetchLanguageUsage, type LanguageCache } from './languageUsage.js';
import { updateProfileReadme } from './profileReadme.js';
import { userInfoQuery } from './queries.js';

config({ path: ['.env'] });

type CommitCache = Record<string, { fetchedAt: string; commits?: CommitInfo[]; dates?: string[] }>;

const activeLanguageRepos = [
  'lifelong-habit',
  'laiflonglearner.com',
  'productive-box',
  'sleeby',
  'lifelong-habit-discord-presence',
];

// No longer worked on: scanned once, then served from the cache.
const frozenLanguageRepos = [
  'lifelong-habit-app',
  'thesis-research',
  'kaggle-notebooks',
  'datacamp-project-solutions',
  'lifelong-habit-journey',
];

const languageRepos = new Set([...activeLanguageRepos, ...frozenLanguageRepos]);

export const getActivitySince = (now = new Date()): string => {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - 365);
  return since.toISOString();
};

export const updateProductiveBox = async () => {
  const octokit = new Octokit({
    auth: `token ${process.env.GH_TOKEN}`,
  });

  const userResponse = await githubQuery<{ viewer: { login: string; id: string } }>(userInfoQuery);
  const { login: username, id } = userResponse.data.viewer;
  if (!username || !id) throw new Error('GitHub viewer is unavailable');

  // Activity and projects cover 365 days; language usage has no date cutoff.
  const activitySince = getActivitySince();
  const repoInfos = await fetchContributedRepos(username);

  /**
   * Include normal repositories and productive-box.
   * Other forks remain excluded.
   */
  const repos: IRepo[] =
    repoInfos
      .filter((repoInfo) => repoInfo?.name !== 'laiflonglearner-vault')
      .filter((repoInfo) => !repoInfo?.isFork || repoInfo?.name === 'productive-box')
      .map((repoInfo) => ({
        name: repoInfo?.name,
        owner: repoInfo?.owner?.login,
      }));
  // GitHub does not list commits to a fork as contributions, so add productive-box directly.
  if (!repos.some((repo) => repo.name === 'productive-box')) repos.push({ name: 'productive-box', owner: username });

  // Only commits newer than the last run are fetched; older ones come from the cache.
  const languageCache = await loadCache<LanguageCache>(octokit, '.productive-box-cache.json', {});
  const commitCache = await loadCache<CommitCache>(octokit, '.productive-box-commits.json', {});
  const fetchedAt = new Date().toISOString();
  // Keep requests sequential to avoid GitHub's shared secondary concurrency limit.
  const repoActivity: IRepoActivity[] = [];
  for (const repo of repos) {
    const key = `${repo.owner}/${repo.name}`;
    const entry = commitCache.data[key];
    // Timestamp-only caches lost commits made in the same second; rebuild them by SHA.
    const cached = entry?.commits ? entry : undefined;
    // Overlap by a day so commits pushed late are still picked up.
    const since = cached ? new Date(Date.parse(cached.fetchedAt) - 86_400_000).toISOString() : activitySince;
    const fresh = await fetchCommittedDates(id, repo.name, repo.owner, since);
    const commits = new Map([...(cached?.commits ?? []), ...fresh].map((commit) => [commit.oid, commit]));
    const recent = [...commits.values()]
      .filter(({ committedDate }) => Date.parse(committedDate) >= Date.parse(activitySince))
      .sort((a, b) => a.committedDate.localeCompare(b.committedDate) || a.oid.localeCompare(b.oid));
    commitCache.data[key] = { fetchedAt, commits: recent };
    repoActivity.push({ repo, committedDates: recent });
  }
  for (const key of Object.keys(commitCache.data)) {
    if (!repos.some((repo) => `${repo.owner}/${repo.name}` === key)) delete commitCache.data[key];
  }

  const timeActivity = getTimeActivity(repoActivity);
  const languageTotals = await fetchLanguageUsage(octokit, username, languageCache.data, languageRepos, new Set(frozenLanguageRepos));
  const dashboardStats = getDashboardStats(repoActivity, languageTotals, timeActivity);

  const nextStatus = await updateProfileReadme(octokit, (currentStatus) =>
    renderDashboardBlock(dashboardStats, currentStatus),
  );

  if (!nextStatus) return;

  for (const key of Object.keys(languageCache.data)) {
    if (!languageRepos.has(key.split('/')[1])) delete languageCache.data[key];
  }
  await saveCache(octokit, '.productive-box-cache.json', languageCache);
  await saveCache(octokit, '.productive-box-commits.json', commitCache);

  console.log(
    `Successfully updated productive box: ${nextStatus} 🎉`,
  );
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  updateProductiveBox().catch((error) => {
    console.error('Unable to update productive box', error);

    process.exitCode = 1;
  });
}
