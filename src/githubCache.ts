import type { Octokit } from '@octokit/rest';

const CACHE_OWNER = 'laiflonglearner';
const CACHE_REPO = 'laiflonglearner';

export interface CacheSnapshot<T> {
  data: T;
  sha?: string;
  before: string;
}

export async function loadCache<T>(
  octokit: Octokit,
  path: string,
  empty: T,
): Promise<CacheSnapshot<T>> {
  const file = await octokit.repos.getContent({ owner: CACHE_OWNER, repo: CACHE_REPO, path }).catch(() => undefined);
  if (!file || Array.isArray(file.data) || !('content' in file.data)) return { data: empty, before: JSON.stringify(empty) };
  try {
    const data = JSON.parse(Buffer.from(file.data.content, 'base64').toString('utf8')) as T;
    return { data, sha: file.data.sha, before: JSON.stringify(data) };
  } catch {
    // an unreadable cache just means a full rescan
    return { data: empty, sha: file.data.sha, before: JSON.stringify(empty) };
  }
}

export async function saveCache<T>(
  octokit: Octokit,
  path: string,
  cache: CacheSnapshot<T>,
) {
  const content = JSON.stringify(cache.data);
  if (content === cache.before) return;
  await octokit.repos
    .createOrUpdateFileContents({
      owner: CACHE_OWNER,
      repo: CACHE_REPO,
      path,
      message: 'chore: update productive box cache',
      content: Buffer.from(content).toString('base64'),
      sha: cache.sha,
    })
    .catch((error) => console.error(`Unable to save ${path}
${error}`));
}

