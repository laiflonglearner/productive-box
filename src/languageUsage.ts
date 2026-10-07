import type { Octokit } from '@octokit/rest';
import { fetchAuthoredLines } from './fetchPaginated.js';
import githubQuery from './githubQuery.js';
import { languageGroups } from './languageGroups.js';
import { createFileMetadataQuery } from './queries.js';

const METADATA_BATCH_SIZE = 50;
const BLAME_BATCH_SIZE = 10;

/** Get every current path, falling back to subtree traversal if GitHub truncates the recursive tree. */
export async function fetchCurrentFiles(octokit: Octokit, owner: string, repo: string, treeSha: string) {
  return (await listFiles(octokit, owner, repo, treeSha)).map((file) => file.path);
}

async function listFiles(octokit: Octokit, owner: string, repo: string, treeSha: string) {
  const recursive = await octokit.git.getTree({ owner, repo, tree_sha: treeSha, recursive: '1' });
  const isFile = <T extends { type?: string; mode?: string; path?: string }>(item: T): item is T & { path: string } =>
    item.type === 'blob' && item.mode !== '120000' && typeof item.path === 'string';
  if (!recursive.data.truncated) return recursive.data.tree.filter(isFile).map((item) => ({ path: item.path, sha: item.sha ?? '' }));

  const files: { path: string; sha: string }[] = [];
  const pending = [{ sha: treeSha, prefix: '' }];
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    const tree = await octokit.git.getTree({ owner, repo, tree_sha: next.sha });
    if (tree.data.truncated) throw new Error(`Non-recursive tree truncated for ${owner}/${repo}/${next.prefix}`);
    for (const item of tree.data.tree) {
      if (!item.path) throw new Error(`Missing tree path for ${owner}/${repo}`);
      const path = `${next.prefix}${item.path}`;
      if (isFile(item)) files.push({ path, sha: item.sha ?? '' });
      if (item.type === 'tree') {
        if (!item.sha) throw new Error(`Missing subtree SHA for ${owner}/${repo}/${path}`);
        pending.push({ sha: item.sha, prefix: `${path}/` });
      }
    }
  }
  return files;
}

type FileMetadata = {
  language: { name: string } | null;
  isGenerated: boolean;
  object: { isBinary: boolean | null } | null;
} | null;

/** A file over 10MB fails its whole batch, so bisect sequentially and mark it 'skip'. */
async function fetchMetadata(owner: string, repo: string, oid: string, paths: string[]): Promise<(FileMetadata | 'skip')[]> {
  try {
    const metadata = await githubQuery<{ repository: { object: Record<string, FileMetadata> | null } | null }>(
      createFileMetadataQuery(owner, repo, oid, paths),
    );
    return paths.map((_, index) => metadata.data.repository?.object?.[`file${index}`] ?? null);
  } catch (error) {
    if (!/over 10mb/i.test(String(error))) throw error;
    if (paths.length === 1) return ['skip'];
    const half = paths.length >> 1;
    return [
      ...(await fetchMetadata(owner, repo, oid, paths.slice(0, half))),
      ...(await fetchMetadata(owner, repo, oid, paths.slice(half))),
    ];
  }
}

export type LanguageCache = Record<string, Record<string, { sha: string; language: string; lines: number }>>;

/**
 * Aggregate present-day, account-attributed lines with no commit-date cutoff.
 * Files whose blob SHA is unchanged since the cached scan are reused, so only changed files are re-blamed.
 */
export async function fetchLanguageUsage(
  octokit: Octokit,
  username: string,
  cache: LanguageCache = {},
): Promise<Map<string, number>> {
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    affiliation: 'owner',
    visibility: 'all',
    per_page: 100,
  });
  const totals = new Map<string, number>();
  for (const repo of repos) {
    if ((repo.fork && repo.name !== 'productive-box') || repo.owner.login.toLowerCase() !== username.toLowerCase()) continue;
    const snapshot = await githubQuery<{
      repository: { defaultBranchRef: { target: { oid: string; tree?: { oid: string } } } | null } | null;
    }>(`query {
      repository(owner: ${JSON.stringify(repo.owner.login)}, name: ${JSON.stringify(repo.name)}) {
        defaultBranchRef { target { ... on Commit { oid tree { oid } } } }
      }
    }`);
    const repository = snapshot.data.repository;
    if (!repository) throw new Error(`Repository ${repo.full_name} is unavailable`);
    // Empty repositories and repositories without a default branch have no current code to count.
    if (!repository.defaultBranchRef) continue;
    const commit = repository.defaultBranchRef.target;
    if (!commit.tree) throw new Error(`Default branch of ${repo.full_name} is not a commit`);
    const allFiles = await listFiles(octokit, repo.owner.login, repo.name, commit.tree.oid);
    const previous = cache[repo.full_name] ?? {};
    const scanned: LanguageCache[string] = {};
    const files: string[] = [];
    for (const file of allFiles) {
      const hit = previous[file.path];
      // ponytail: unchanged blob assumed to keep its blame attribution; clear the cache file to force a rescan
      if (file.sha && hit?.sha === file.sha) scanned[file.path] = hit;
      else files.push(file.path);
    }
    const shas = new Map(allFiles.map((file) => [file.path, file.sha]));
    // Keep GitHub's existing code-language scope, excluding prose/data languages from the dashboard.
    const languages = await octokit.repos.listLanguages({ owner: repo.owner.login, repo: repo.name });
    const codeLanguages = new Set(Object.keys(languages.data));
    const sourceFiles: { path: string; language: string }[] = [];
    for (let offset = 0; offset < files.length; offset += METADATA_BATCH_SIZE) {
      const paths = files.slice(offset, offset + METADATA_BATCH_SIZE);
      const metadata = await fetchMetadata(repo.owner.login, repo.name, commit.oid, paths);
      for (const [index, path] of paths.entries()) {
        const file = metadata[index];
        scanned[path] = { sha: shas.get(path) ?? '', language: '', lines: 0 };
        if (file === 'skip') continue;
        if (!file) throw new Error(`File metadata unavailable for ${repo.full_name}/${path}`);
        const detectedLanguage = file.language?.name;
        const language = detectedLanguage && (languageGroups.get(detectedLanguage) ?? detectedLanguage);
        if (!language || !codeLanguages.has(language) || file.isGenerated) continue;
        if (file.object?.isBinary == null) throw new Error(`File encoding unavailable for ${repo.full_name}/${path}`);
        if (!file.object.isBinary) sourceFiles.push({ path, language });
      }
    }
    for (let offset = 0; offset < sourceFiles.length; offset += BLAME_BATCH_SIZE) {
      const batch = sourceFiles.slice(offset, offset + BLAME_BATCH_SIZE);
      const lines = await fetchAuthoredLines(
        username,
        repo.owner.login,
        repo.name,
        commit.oid,
        batch.map((file) => file.path),
      );
      for (const [index, file] of batch.entries()) {
        scanned[file.path] = { ...scanned[file.path], language: file.language, lines: lines[index] };
      }
    }
    cache[repo.full_name] = scanned;
    for (const { language, lines } of Object.values(scanned)) {
      if (language && lines > 0) totals.set(language, (totals.get(language) ?? 0) + lines);
    }
  }
  return totals;
}
