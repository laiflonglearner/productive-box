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

export interface FileChange {
  path: string;
  content: string;
}

// Returns the cache file to write, or undefined when nothing changed.
export function cacheChange<T>(path: string, cache: CacheSnapshot<T>): FileChange | undefined {
  const content = JSON.stringify(cache.data);
  return content === cache.before ? undefined : { path, content };
}

// Writes every file in one commit; the contents API would make one commit per file.
export async function commitFiles(octokit: Octokit, files: FileChange[], message: string) {
  if (!files.length) return;
  const owner = CACHE_OWNER;
  const repo = CACHE_REPO;
  const { data: repository } = await octokit.repos.get({ owner, repo });
  const ref = `heads/${repository.default_branch}`;
  const { data: head } = await octokit.git.getRef({ owner, repo, ref });
  const { data: parent } = await octokit.git.getCommit({ owner, repo, commit_sha: head.object.sha });
  const { data: tree } = await octokit.git.createTree({
    owner,
    repo,
    base_tree: parent.tree.sha,
    tree: files.map(({ path, content }) => ({ path, mode: '100644' as const, type: 'blob' as const, content })),
  });
  const { data: commit } = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.sha,
    parents: [head.object.sha],
  });
  await octokit.git.updateRef({ owner, repo, ref, sha: commit.sha });
}
