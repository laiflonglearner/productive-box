import githubQuery, { type GraphQLResponse } from './githubQuery.js';
import { createBlameQuery, createCommittedDateQuery, createContributedRepoQuery } from './queries.js';

export interface RepoInfo {
  name: string;
  owner: { login: string };
  isFork: boolean;
}

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (T | null)[] | null;
}

interface BlameRange {
  startingLine: number;
  endingLine: number;
  commit: { author: { user: { login: string } | null } | null };
}

/**
 * Follow the GraphQL cursor until the connection has no next page.
 */
async function fetchAllPages<T, R>(
  createQuery: (after?: string) => string,
  selectConnection: (response: GraphQLResponse<R>) => Connection<T> | null,
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;

  do {
    const connection = selectConnection(await githubQuery<R>(createQuery(after)));
    if (!connection) {
      if (after) throw new Error('GitHub connection disappeared during pagination');
      return items;
    }
    if (!Array.isArray(connection.nodes)) throw new Error('GitHub returned an invalid connection');
    items.push(...connection.nodes.filter((node): node is T => node !== null));
    if (!connection.pageInfo.hasNextPage) return items;
    const cursor = connection.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw new Error('GitHub pagination did not advance');
    cursors.add(cursor);
    after = cursor;
  } while (after);

  return items;
}

export const fetchContributedRepos = (username: string) =>
  fetchAllPages<RepoInfo, { user: { repositoriesContributedTo: Connection<RepoInfo> } | null }>(
    (after) => createContributedRepoQuery(username, after),
    (response) => {
      if (!response.data.user) throw new Error('GitHub user is unavailable');
      return response.data.user.repositoriesContributedTo;
    },
  );

export const fetchCommittedDates = (id: string, name: string, owner: string, since: string) =>
  fetchAllPages<
    { committedDate: string },
    {
      repository: { defaultBranchRef: { target: { history?: Connection<{ committedDate: string }> } } | null } | null;
    }
  >(
    (after) => createCommittedDateQuery(id, name, owner, since, after),
    (response) => {
      const repository = response.data.repository;
      if (!repository) throw new Error(`Repository ${owner}/${name} is unavailable`);
      if (!repository.defaultBranchRef) return null;
      const history = repository.defaultBranchRef.target.history;
      if (!history) throw new Error(`Default branch of ${owner}/${name} is not a commit`);
      return history;
    },
  );

/**
 * Count current lines whose latest blamed commit is attributed to this GitHub user.
 * Unlinked authors do not count. Missing blame is an error, never a zero result.
 */
export const fetchAuthoredLines = async (
  username: string,
  owner: string,
  name: string,
  commit: string,
  paths: string[],
): Promise<number[]> => {
  const response = await githubQuery<{
    repository: { object: Record<string, { ranges: BlameRange[] } | null> | null } | null;
  }>(createBlameQuery(owner, name, commit, paths));
  const object = response.data.repository?.object;
  return paths.map((path, index) => {
    const ranges = object?.[`file${index}`]?.ranges;
    if (!Array.isArray(ranges)) throw new Error(`Blame unavailable for ${owner}/${name}/${path}`);
    return ranges.reduce((total, range) => {
      if (
        !Number.isInteger(range.startingLine) ||
        !Number.isInteger(range.endingLine) ||
        range.startingLine < 1 ||
        range.endingLine < range.startingLine
      ) {
        throw new Error(`Invalid blame range for ${owner}/${name}/${path}`);
      }
      return range.commit.author?.user?.login.toLowerCase() === username.toLowerCase()
        ? total + range.endingLine - range.startingLine + 1
        : total;
    }, 0);
  });
};
