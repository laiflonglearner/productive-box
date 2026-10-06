import githubQuery from './githubQuery.js';
import { createCommittedDateQuery, createContributedRepoQuery } from './queries.js';

export interface RepoInfo {
  name: string;
  owner: {
    login: string;
  };
  isFork: boolean;
}

interface Connection<T> {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: T[];
}

/**
 * Follow the GraphQL cursor until the connection has no next page
 */
async function fetchAllPages<T>(
  createQuery: (after?: string) => string,
  selectConnection: (response: any) => Connection<T> | undefined,
): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;

  do {
    const response = await githubQuery(createQuery(after));

    /**
     * If the token is invalid, stop the process
     */
    if (response?.message === 'Bad credentials') {
      throw new Error('Invalid GitHub token. Please renew the GH_TOKEN');
    }

    if (response?.errors) {
      console.error(`GraphQL query failed, results may be incomplete\n${JSON.stringify(response.errors)}`);
      break;
    }

    const connection = selectConnection(response);
    if (!connection) break;

    items.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? (connection.pageInfo.endCursor ?? undefined) : undefined;
  } while (after);

  return items;
}

export const fetchContributedRepos = (username: string) =>
  fetchAllPages<RepoInfo>(
    (after) => createContributedRepoQuery(username, after),
    (response) => response?.data?.user?.repositoriesContributedTo,
  );

export const fetchCommittedDates = (id: string, name: string, owner: string) =>
  fetchAllPages<{ committedDate: string }>(
    (after) => createCommittedDateQuery(id, name, owner, after),
    (response) => response?.data?.repository?.defaultBranchRef?.target?.history,
  );
