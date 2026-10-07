import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import githubQuery from '../src/githubQuery.ts';
import { fetchCommittedDates, fetchContributedRepos } from '../src/fetchPaginated.ts';
import { createContributedRepoQuery } from '../src/queries.ts';
import { fetchAuthoredLines } from '../src/fetchPaginated.ts';
import { fetchCurrentFiles, fetchLanguageUsage } from '../src/languageUsage.ts';
import { daytimeFilenames } from '../src/filenames.ts';
import { Octokit } from '@octokit/rest';

const { getActivitySince, updateProductiveBox } = await import(
  process.env.TEST_BUNDLE === '1' ? '../dist/index.js' : '../src/index.ts'
);

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

test('repository discovery does not send the unsupported since argument', () => {
  assert.doesNotMatch(createContributedRepoQuery('owner'), /since:/);
});

test('GraphQL errors reject instead of turning into zero results', async () => {
  globalThis.fetch = async () => Response.json({ errors: [{ message: 'Unavailable blame' }] });
  await assert.rejects(githubQuery('query { viewer { login } }'), /Unavailable blame/);
});

test('non-JSON server errors retry with bounded backoff', async () => {
  const delays = [];
  globalThis.setTimeout = (callback, delay) => { delays.push(delay); callback(); };
  let requests = 0;
  globalThis.fetch = async () => requests++ === 0
    ? new Response('Bad gateway', { status: 502 })
    : Response.json({ data: { viewer: { login: 'owner' } } });
  assert.equal((await githubQuery('query { viewer { login } }')).data.viewer.login, 'owner');
  assert.deepEqual(delays, [1000]);
  assert.equal(requests, 2);
});

test('a long rate-limit reset fails safely without repeatedly calling GitHub', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600),
    } });
  };
  await assert.rejects(githubQuery('query { viewer { login } }'), /rate limit exceeded; retry after/);
  assert.equal(requests, 1);
});

test('file path escapes survive the GraphQL request body', async () => {
  globalThis.fetch = async (_url, options) => {
    const query = JSON.parse(options.body).query;
    assert.ok(query.includes('blame(path: "line\\nname.ts")'));
    return Response.json({ data: { repository: { object: { file0: { ranges: [] } } } } });
  };
  assert.deepEqual(await fetchAuthoredLines('owner', 'owner', 'repo', 'sha', ['line\nname.ts']), [0]);
});

test('repository pagination ignores null nodes and follows every cursor', async () => {
  let page = 0;
  globalThis.fetch = async () => Response.json({ data: { user: { repositoriesContributedTo: {
    nodes: page++ === 0 ? [null, { name: 'one', owner: { login: 'owner' }, isFork: false }] :
      [{ name: 'two', owner: { login: 'owner' }, isFork: false }],
    pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? 'next' : null },
  } } } });
  assert.deepEqual((await fetchContributedRepos('owner')).map(repo => repo.name), ['one', 'two']);
  assert.equal(page, 2);
});

test('an empty repository has no activity', async () => {
  globalThis.fetch = async () => Response.json({ data: { repository: { defaultBranchRef: null } } });
  assert.deepEqual(await fetchCommittedDates('user-id', 'empty', 'owner', '2025-01-01T00:00:00Z'), []);
});

test('a failed later history page rejects the entire result', async () => {
  let page = 0;
  globalThis.fetch = async () => Response.json(page++ === 0 ? { data: { repository: {
    defaultBranchRef: { target: { history: { nodes: [{ committedDate: '2026-01-01T00:00:00Z' }],
      pageInfo: { hasNextPage: true, endCursor: 'next' } } } },
  } } } : { errors: [{ message: 'History failed' }] });
  await assert.rejects(fetchCommittedDates('id', 'repo', 'owner', '2025-01-01T00:00:00Z'), /History failed/);
});

test('missing or repeated pagination cursors reject incomplete results', async () => {
  for (const cursor of [null, 'repeated']) {
    globalThis.fetch = async () => Response.json({ data: { user: { repositoriesContributedTo: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: cursor },
    } } } });
    await assert.rejects(fetchContributedRepos('owner'), /pagination did not advance/);
  }
});

test('a branch disappearing during pagination rejects partial history', async () => {
  let page = 0;
  globalThis.fetch = async () => Response.json({ data: { repository: { defaultBranchRef: page++ === 0 ? {
    target: { history: { nodes: [{ committedDate: '2026-01-01T00:00:00Z' }],
      pageInfo: { hasNextPage: true, endCursor: 'next' } } },
  } : null } } });
  await assert.rejects(fetchCommittedDates('id', 'repo', 'owner', '2025-01-01T00:00:00Z'), /disappeared/);
});

test('blame counts inclusive ranges only for the linked account', async () => {
  const range = (startingLine, endingLine, user) => ({ startingLine, endingLine,
    commit: { author: user === undefined ? null : { user } } });
  globalThis.fetch = async (_url, options) => {
    const { query } = JSON.parse(options.body);
    assert.match(query, /object\(oid: "pinned-sha"\)/);
    assert.doesNotMatch(query, /since:/);
    return Response.json({ data: { repository: { object: { file0: { ranges: [
      range(1, 4, { login: 'OwNeR' }), range(5, 8, { login: 'other' }),
      range(9, 10, null), range(11, 11), range(12, 13, { login: 'owner' }),
    ] }, file1: { ranges: [] } } } } });
  };
  assert.deepEqual(await fetchAuthoredLines('owner', 'owner', 'repo', 'pinned-sha', ['one.ts', 'empty.ts']), [6, 0]);
});

test('missing blame is rejected rather than counted as zero', async () => {
  globalThis.fetch = async () => Response.json({ data: { repository: { object: { file0: null } } } });
  await assert.rejects(fetchAuthoredLines('owner', 'owner', 'repo', 'sha', ['one.ts']), /Blame unavailable/);
});

test('invalid blame ranges reject instead of creating negative language counts', async () => {
  globalThis.fetch = async () => Response.json({ data: { repository: { object: { file0: { ranges: [
    { startingLine: 4, endingLine: 3, commit: { author: { user: { login: 'owner' } } } },
  ] } } } } });
  await assert.rejects(fetchAuthoredLines('owner', 'owner', 'repo', 'sha', ['one.ts']), /Invalid blame range/);
});

test('truncated recursive trees are replaced by complete subtree traversal', async () => {
  const octokit = { git: { getTree: async (options) => {
    if (options.recursive) return { data: { truncated: true, tree: [{ type: 'blob', path: 'partial.ts' }] } };
    if (options.tree_sha === 'root') return { data: { truncated: false, tree: [
      { type: 'tree', path: 'a', sha: 'shared' }, { type: 'tree', path: 'b', sha: 'shared' },
      { type: 'blob', path: 'link.ts', mode: '120000' }, { type: 'commit', path: 'submodule' },
    ] } };
    return { data: { truncated: false, tree: [{ type: 'blob', path: 'code.ts', mode: '100644' }] } };
  } } };
  assert.deepEqual((await fetchCurrentFiles(octokit, 'owner', 'repo', 'root')).sort(), ['a/code.ts', 'b/code.ts']);
});

test('non-recursive truncation fails instead of publishing partial counts', async () => {
  const octokit = { git: { getTree: async () => ({ data: { truncated: true, tree: [] } }) } };
  await assert.rejects(fetchCurrentFiles(octokit, 'owner', 'repo', 'root'), /Non-recursive tree truncated/);
});

test('owned private code is included, forks excluded, and GitHub assigns the file languages', async () => {
  const repo = { name: 'private', owner: { login: 'owner' }, full_name: 'owner/private', fork: false, private: true };
  const octokit = {
    paginate: async (_method, options) => {
      assert.deepEqual(options, { affiliation: 'owner', visibility: 'all', per_page: 100 });
      return [{ ...repo, fork: true }, { ...repo, owner: { login: 'other' } }, repo,
        { ...repo, name: 'empty' }];
    },
    repos: { listForAuthenticatedUser() {}, listLanguages: async () => ({ data: {
      'CAP CDS': 12, 'Jupyter Notebook': 12, SQL: 12, TypeScript: 12,
    } }) },
    git: { getTree: async () => ({ data: { truncated: false, tree: [
      'code.cds', 'experiment.ipynb', 'query.sql', 'component.tsx', 'generated.ts', 'README.md', 'binary.ts',
    ].map(path => ({ type: 'blob', mode: '100644', path })) } }) },
  };
  let blameQueries = 0;
  globalThis.fetch = async (_url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes('defaultBranchRef')) return Response.json({ data: { repository: {
      defaultBranchRef: query.includes('"empty"') ? null : { target: { oid: 'pinned-sha', tree: { oid: 'root' } } },
    } } });
    assert.match(query, /oid: "pinned-sha"/);
    if (query.includes('file(path:')) return Response.json({ data: { repository: { object: Object.fromEntries(
      ['CAP CDS', 'Jupyter Notebook', 'SQL', 'TSX', 'TypeScript', 'Markdown', 'TypeScript'].map((name, index) => [
        `file${index}`, { language: { name }, isGenerated: index === 4, object: { isBinary: index === 6 } },
      ]),
    ) } } });
    blameQueries++;
    return Response.json({ data: { repository: { object: Object.fromEntries([0, 1, 2, 3].map(index => [
      `file${index}`, { ranges: [{ startingLine: 1, endingLine: index + 1,
        commit: { author: { user: { login: 'owner' } } } }] },
    ])) } } });
  };
  assert.deepEqual(Object.fromEntries(await fetchLanguageUsage(octokit, 'owner')),
    { 'CAP CDS': 1, 'Jupyter Notebook': 2, SQL: 3, TypeScript: 4 });
  assert.equal(blameQueries, 1);
});

test('authenticated owned repository discovery follows REST pagination', async () => {
  const pages = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') ?? 1);
    pages.push(page);
    return Response.json([{ name: `empty-${page}`, owner: { login: 'owner' }, fork: false }], {
      headers: page === 1 ? { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } : {},
    });
  };
  const octokit = new Octokit();
  // Empty branches require GraphQL responses, not another REST repository page.
  const restFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).endsWith('/graphql')
    ? Response.json({ data: { repository: { defaultBranchRef: null } } }) : restFetch(url, options);
  assert.deepEqual(Object.fromEntries(await fetchLanguageUsage(octokit, 'owner')), {});
  assert.deepEqual(pages, [1, 2]);
});

test('large file lists use bounded metadata and blame batches', async () => {
  const paths = Array.from({ length: 51 }, (_, index) => `code${index}.ts`);
  const octokit = {
    paginate: async () => [{ name: 'repo', owner: { login: 'owner' }, full_name: 'owner/repo', fork: false }],
    repos: { listForAuthenticatedUser() {}, listLanguages: async () => ({ data: { TypeScript: 51 } }) },
    git: { getTree: async () => ({ data: { truncated: false,
      tree: paths.map(path => ({ type: 'blob', mode: '100644', path })) } }) },
  };
  const metadataBatches = [];
  const blameBatches = [];
  globalThis.fetch = async (_url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes('defaultBranchRef')) return Response.json({ data: { repository: {
      defaultBranchRef: { target: { oid: 'sha', tree: { oid: 'tree' } } },
    } } });
    const isMetadata = query.includes('file(path:');
    const aliases = [...query.matchAll(/(file\d+): /g)].map(match => match[1]);
    (isMetadata ? metadataBatches : blameBatches).push(aliases.length);
    return Response.json({ data: { repository: { object: Object.fromEntries(aliases.map(alias => [alias,
      isMetadata ? { language: { name: 'TypeScript' }, isGenerated: false, object: { isBinary: false } } :
        { ranges: [{ startingLine: 1, endingLine: 1, commit: { author: { user: { login: 'owner' } } } }] },
    ])) } } });
  };
  assert.deepEqual(Object.fromEntries(await fetchLanguageUsage(octokit, 'owner')), { TypeScript: 51 });
  assert.deepEqual(metadataBatches, [50, 1]);
  assert.deepEqual(blameBatches, [10, 10, 10, 10, 10, 1]);
});

test('the 365-day cutoff handles leap years without mutating the input', () => {
  const now = new Date('2024-03-01T12:00:00Z');
  assert.equal(getActivitySince(now), '2023-03-02T12:00:00.000Z');
  assert.equal(now.toISOString(), '2024-03-01T12:00:00.000Z');
});

function mockDashboard({ commits = [], failBlame = false, emptyLanguages = false } = {}) {
  const currentReadme = `prefix\n<!-- productive-box:start -->\n### ${daytimeFilenames[0]}\nold\n<!-- productive-box:end -->\nsuffix`;
  let updatedReadme;
  let writes = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/graphql')) {
      const { query } = JSON.parse(options.body);
      let data;
      if (query.includes('viewer')) data = { viewer: { login: 'owner', id: 'id' } };
      else if (query.includes('repositoriesContributedTo')) {
        assert.doesNotMatch(query, /since:/);
        data = { user: { repositoriesContributedTo: { nodes: [
          { name: 'sleeby', owner: { login: 'owner' }, isFork: false },
        ], pageInfo: { hasNextPage: false, endCursor: null } } } };
      } else if (query.includes('history(')) {
        assert.match(query, /since: "\d{4}-\d\d-\d\dT/);
        data = { repository: { defaultBranchRef: { target: { history: {
          nodes: query.includes('name: "sleeby"') ? commits.map(committedDate => ({ committedDate })) : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } } };
      } else if (query.includes('defaultBranchRef')) data = { repository: { defaultBranchRef: {
        target: { oid: 'sha', tree: { oid: 'tree' } },
      } } };
      else if (query.includes('file(path:')) data = { repository: { object: { file0: {
        language: emptyLanguages ? null : { name: 'TypeScript' }, isGenerated: false, object: { isBinary: false },
      } } } };
      else if (failBlame) return Response.json({ errors: [{ message: 'Blame failed' }] });
      else data = { repository: { object: { file0: { ranges: [{ startingLine: 1, endingLine: 20,
        commit: { author: { user: { login: 'owner' } } } }] } } } };
      return Response.json({ data });
    }
    if (String(url).includes('/user/repos')) return Response.json([
      { name: 'sleeby', owner: { login: 'owner' }, full_name: 'owner/sleeby', fork: false },
    ]);
    if (String(url).includes('/git/trees/')) return Response.json({ truncated: false, tree: [
      { type: 'blob', mode: '100644', path: 'code.ts', sha: 'blob' },
    ] });
    if (String(url).endsWith('/languages')) return Response.json({ TypeScript: 50 });
    if (options.method === 'PUT' && String(url).includes('productive-box-cache')) return Response.json({ content: {} });
    if (options.method === 'PUT') {
      writes++;
      const body = JSON.parse(options.body);
      assert.equal(body.sha, 'readme-sha');
      updatedReadme = Buffer.from(body.content, 'base64').toString('utf8');
      return Response.json({ content: { sha: 'new-sha' } });
    }
    if (String(url).includes('/contents/README.md')) return Response.json({ type: 'file', sha: 'readme-sha',
      encoding: 'base64', content: Buffer.from(currentReadme).toString('base64') });
    throw new Error(`Unexpected request: ${url}`);
  };
  return { readme: () => updatedReadme, writes: () => writes };
}

test('zero recent commits still updates all-time language usage and preserves status and markers', async () => {
  const fixture = mockDashboard();
  await updateProductiveBox();
  assert.equal(fixture.writes(), 1);
  const readme = fixture.readme();
  assert.ok(readme.startsWith('prefix\n<!-- productive-box:start -->'));
  assert.ok(readme.endsWith('<!-- productive-box:end -->\nsuffix'));
  assert.ok(readme.includes(`### ${daytimeFilenames[0]}`));
  assert.match(readme, /TypeScript .*100\.0%/);
  assert.doesNotMatch(readme, /NaN|Infinity/);
  assert.equal((readme.match(/commits\n/g) ?? []).length, 5);
});

test('successful recent activity retains project totals and rotates away from the current status', async () => {
  const now = new Date();
  const fixture = mockDashboard({ commits: [now.toISOString()] });
  await updateProductiveBox();
  assert.match(fixture.readme(), /sleeby .*100\.0% 1 commits/);
  assert.ok(!fixture.readme().includes(`### ${daytimeFilenames[0]}`));
  assert.equal((fixture.readme().match(/1 commits/g) ?? []).length, 3);
});

test('zero language results render explicitly without NaN or Infinity', async () => {
  const fixture = mockDashboard({ emptyLanguages: true });
  await updateProductiveBox();
  assert.match(fixture.readme(), /No attributed code found\./);
  assert.doesNotMatch(fixture.readme(), /NaN|Infinity/);
  assert.equal(fixture.writes(), 1);
});

test('activity and projects include older recent commits while months only include the last five months', async () => {
  const now = new Date();
  const older = new Date(now);
  older.setUTCDate(older.getUTCDate() - 200);
  const fixture = mockDashboard({ commits: [now.toISOString(), older.toISOString()] });
  await updateProductiveBox();
  assert.match(fixture.readme(), /sleeby .*100\.0% 2 commits/);
  const months = [...fixture.readme().matchAll(/[A-Z][a-z]{2} ‘\d{2} [✦✧]+ +(\d+) commits/g)];
  assert.equal(months.length, 5);
  assert.equal(months.reduce((total, month) => total + Number(month[1]), 0), 1);
});

test('an incomplete language scan never writes the README', async () => {
  const fixture = mockDashboard({ failBlame: true });
  await assert.rejects(updateProductiveBox(), /Blame failed/);
  assert.equal(fixture.writes(), 0);
});

test('unchanged files are reused from the cache and not re-queried', async () => {
  const octokit = {
    paginate: async () => [{ name: 'repo', owner: { login: 'owner' }, full_name: 'owner/repo', fork: false }],
    repos: { listForAuthenticatedUser() {}, listLanguages: async () => ({ data: { TypeScript: 1 } }) },
    git: { getTree: async () => ({ data: { truncated: false,
      tree: [{ type: 'blob', mode: '100644', path: 'a.ts', sha: 'blob1' }] } }) },
  };
  let queries = 0;
  globalThis.fetch = async (_url, options) => {
    queries++;
    const { query } = JSON.parse(options.body);
    const data = query.includes('defaultBranchRef')
      ? { repository: { defaultBranchRef: { target: { oid: 'c', tree: { oid: 't' } } } } }
      : query.includes('file(path:')
        ? { repository: { object: { file0: { language: { name: 'TypeScript' }, isGenerated: false, object: { isBinary: false } } } } }
        : { repository: { object: { file0: { ranges: [{ startingLine: 1, endingLine: 5,
          commit: { author: { user: { login: 'owner' } } } }] } } } };
    return Response.json({ data });
  };
  const cache = {};
  assert.deepEqual(Object.fromEntries(await fetchLanguageUsage(octokit, 'owner', cache)), { TypeScript: 5 });
  const first = queries;
  assert.deepEqual(Object.fromEntries(await fetchLanguageUsage(octokit, 'owner', cache)), { TypeScript: 5 });
  assert.equal(queries - first, 1); // only the head-commit lookup
});

test('frozen repos are served from the cache with no API calls', async () => {
  const octokit = {
    paginate: async () => [{ name: 'old', owner: { login: 'owner' }, full_name: 'owner/old', fork: false }],
    repos: { listForAuthenticatedUser() {} },
  };
  globalThis.fetch = async () => { throw new Error('unexpected request'); };
  const cache = { 'owner/old': { 'a.ts': { sha: 'x', language: 'TypeScript', lines: 7 } } };
  const totals = await fetchLanguageUsage(octokit, 'owner', cache, new Set(['old']), new Set(['old']));
  assert.deepEqual(Object.fromEntries(totals), { TypeScript: 7 });
});
