export const userInfoQuery = `
  query {
    viewer {
      login
      id
    }
  }
`;

const afterArg = (after?: string): string => (after ? `, after: ${JSON.stringify(after)}` : '');

export const createContributedRepoQuery = (username: string, after?: string) => `
  query {
    user(login: ${JSON.stringify(username)}) {
      repositoriesContributedTo(
        first: 100, includeUserRepositories: true, contributionTypes: [COMMIT]${afterArg(after)}
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { isFork name owner { login } }
      }
    }
  }
`;

export const createCommittedDateQuery = (id: string, name: string, owner: string, since: string, after?: string) => `
  query {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 100, author: { id: ${JSON.stringify(id)} }, since: ${JSON.stringify(since)}${afterArg(after)}) {
              pageInfo { hasNextPage endCursor }
              nodes { committedDate }
            }
          }
        }
      }
    }
  }
`;

export const createFileMetadataQuery = (owner: string, name: string, commit: string, paths: string[]) => `
  query {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      object(oid: ${JSON.stringify(commit)}) {
        ... on Commit {
          ${paths
            .map(
              (path, index) => `
            file${index}: file(path: ${JSON.stringify(path)}) {
              language { name }
              isGenerated
              object { ... on Blob { isBinary } }
            }
          `,
            )
            .join('\n')}
        }
      }
    }
  }
`;

export const createBlameQuery = (owner: string, name: string, commit: string, paths: string[]) => `
  query {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      object(oid: ${JSON.stringify(commit)}) {
        ... on Commit {
          ${paths
            .map(
              (path, index) => `
            file${index}: blame(path: ${JSON.stringify(path)}) {
              ranges {
                startingLine
                endingLine
                commit { author { user { login } } }
              }
            }
          `,
            )
            .join('\n')}
        }
      }
    }
  }
`;
