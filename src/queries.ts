export const userInfoQuery = `
  query {
    viewer {
      login
      id
    }
  }
`;

const afterArg = (after?: string) => (after ? `, after: "${after}"` : '');

export const createContributedRepoQuery = (username: string, after?: string) => `
  query {
    user(login: "${username}") {
      repositoriesContributedTo(first: 100, includeUserRepositories: true${afterArg(after)}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isFork
          name
          owner {
            login
          }
        }
      }
    }
  }
`;

export const createCommittedDateQuery = (id: string, name: string, owner: string, after?: string) => `
  query {
    repository(owner: "${owner}", name: "${name}") {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 100, author: { id: "${id}" }${afterArg(after)}) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                committedDate
              }
            }
          }
        }
      }
    }
  }
`;
