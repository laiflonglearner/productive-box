import { Octokit } from '@octokit/rest';
import { config } from 'dotenv';

import {
  fetchCommittedDates,
  fetchContributedRepos,
} from './fetchPaginated.js';
import {
  daytimeFilenames,
  nighttimeFilenames,
} from './filenames.js';
import generateBarChart from './generateBarChart.js';
import githubQuery from './githubQuery.js';
import { userInfoQuery } from './queries.js';

config({ path: ['.env'] });

interface IRepo {
  name: string;
  owner: string;
}

interface ILanguage {
  name: string;
  bytes: number;
}

interface ICommitDate {
  committedDate: string;
}

interface IRepoActivity {
  repo: IRepo;
  committedDates: ICommitDate[];
}

interface IProject {
  name: string;
  repos: string[];
}

interface IProjectActivity {
  name: string;
  commits: number;
}

interface IMonthActivity {
  key: string;
  label: string;
  commits: number;
}

const projects: IProject[] = [
  {
    name: '🌿 lifelong-habit',
    repos: [
      'lifelong-habit',
      'lifelong-habit-app',
    ],
  },
  {
    name: '🪶 laiflonglearner.com',
    repos: ['laiflonglearner.com'],
  },
  {
    name: '🧮 productive-box',
    repos: ['productive-box'],
  },
  {
    name: '🌙 sleeby',
    repos: ['sleeby'],
  },
];

const getRandomStatus = (
  isDaytime: boolean,
  currentStatus: string,
): string => {
  const statuses = isDaytime
    ? daytimeFilenames
    : nighttimeFilenames;

  const available = statuses.filter(
    (status) => status !== currentStatus,
  );

  const pool = available.length
    ? available
    : statuses;

  return pool[Math.floor(Math.random() * pool.length)];
};

const allocateBarUnits = (
  values: number[],
  totalUnits: number,
): number[] => {
  const total = values.reduce(
    (sum, value) => sum + value,
    0,
  );

  if (!total) {
    return values.map(() => 0);
  }

  const exact = values.map(
    (value) => (value / total) * totalUnits,
  );

  const units = exact.map(Math.floor);

  const remaining =
    totalUnits -
    units.reduce(
      (sum, value) => sum + value,
      0,
    );

  const remainders = exact
    .map((value, index) => ({
      index,
      remainder: value - Math.floor(value),
    }))
    .sort(
      (a, b) => b.remainder - a.remainder,
    );

  for (let i = 0; i < remaining; i++) {
    units[remainders[i].index]++;
  }

  return units;
};

const generateSparkleBar = (
  filled: number,
  length: number,
): string =>
  '✦'.repeat(filled) +
  '✧'.repeat(length - filled);

/**
 * Combine two sets of lines into fixed-width columns.
 */
const combineColumns = (
  leftLines: string[],
  rightLines: string[],
  gap = 8,
): string[] => {
  const leftWidth = Math.max(
    0,
    ...leftLines.map((line) => line.length),
  );

  const rowCount = Math.max(
    leftLines.length,
    rightLines.length,
  );

  return Array.from(
    { length: rowCount },
    (_, index) => {
      const left = leftLines[index] ?? '';
      const right = rightLines[index] ?? '';

      return `${left.padEnd(leftWidth)}${' '.repeat(gap)}${right}`;
    },
  );
};

const getLastFiveMonths = (): IMonthActivity[] => {
  const formatter =
    new Intl.DateTimeFormat(
      'en-US',
      {
        month: 'short',
        year: '2-digit',
        timeZone:
          process.env.TIMEZONE,
      },
    );

  const now = new Date();

  return Array.from(
    { length: 5 },
    (_, index) => {
      const monthsAgo = 4 - index;

      const date = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() -
            monthsAgo,
          15,
          12,
        ),
      );

      const parts =
        formatter.formatToParts(date);

      const month = parts.find(
        (part) =>
          part.type === 'month',
      )?.value;

      const year = parts.find(
        (part) =>
          part.type === 'year',
      )?.value;

      return {
        key: `${year}-${month}`,
        label: `${month} '${year}`,
        commits: 0,
      };
    },
  );
};

(async () => {
  const octokit = new Octokit({
    auth: `token ${process.env.GH_TOKEN}`,
  });

  const userResponse =
    await githubQuery(
      userInfoQuery,
    ).catch((error) =>
      console.error(
        `Unable to get username and id\n${error}`,
      ),
    );

  const { login: username, id } =
    userResponse?.data?.viewer ?? {};

  if (!username || !id) return;

  const repoInfos =
    await fetchContributedRepos(
      username,
    ).catch((error) =>
      console.error(
        `Unable to get the contributed repos\n${error}`,
      ),
    );

  if (!repoInfos) return;

  /**
   * Include normal repositories and productive-box.
   * Other forks remain excluded.
   */
  const repos: IRepo[] =
    repoInfos
      .filter(
        (repoInfo) =>
          !repoInfo?.isFork ||
          repoInfo?.name ===
            'productive-box',
      )
      .map((repoInfo) => ({
        name: repoInfo?.name,
        owner:
          repoInfo?.owner?.login,
      }));

  let repoActivity: IRepoActivity[];
  let languagesByRepo: Record<
    string,
    number
  >[];

  try {
    [
      repoActivity,
      languagesByRepo,
    ] = await Promise.all([
      Promise.all(
        repos.map(
          async (repo) => ({
            repo,
            committedDates:
              await fetchCommittedDates(
                id,
                repo.name,
                repo.owner,
              ),
          }),
        ),
      ),

      Promise.all(
        repos.map(
          ({ name, owner }) =>
            octokit.repos
              .listLanguages({
                owner,
                repo: name,
              })
              .then(
                (response) =>
                  response.data,
              )
              .catch(
                (error) => {
                  console.error(
                    `Unable to get languages for ${owner}/${name}\n${error}`,
                  );

                  return {};
                },
              ),
        ),
      ),
    ]);
  } catch (error) {
    console.error(
      `Unable to get GitHub activity\n${error}`,
    );

    return;
  }

  const allCommittedDates =
    repoActivity.flatMap(
      ({ committedDates }) =>
        committedDates,
    );

  /**
   * Time-of-day activity.
   */
  let morning = 0;
  let daytime = 0;
  let evening = 0;
  let night = 0;

  allCommittedDates.forEach(
    ({ committedDate }) => {
      const hour = Number(
        new Date(committedDate)
          .toLocaleTimeString(
            'en-US',
            {
              hourCycle: 'h23',
              timeZone:
                process.env.TIMEZONE,
            },
          )
          .split(':')[0],
      );

      if (
        hour >= 4 &&
        hour < 13
      ) {
        morning++;
      }

      if (
        hour >= 13 &&
        hour < 17
      ) {
        daytime++;
      }

      if (
        hour >= 17 &&
        hour < 21
      ) {
        evening++;
      }

      if (
        hour >= 21 ||
        hour < 4
      ) {
        night++;
      }
    },
  );

  /**
   * Languages.
   */
  const languageTotals =
    new Map<string, number>();

  languagesByRepo.forEach(
    (languages) => {
      Object.entries(
        languages,
      ).forEach(
        ([language, bytes]) => {
          languageTotals.set(
            language,
            (languageTotals.get(
              language,
            ) ?? 0) + bytes,
          );
        },
      );
    },
  );

  const totalLanguageBytes =
    Array.from(
      languageTotals.values(),
    ).reduce(
      (sum, bytes) =>
        sum + bytes,
      0,
    );

  const topLanguages: ILanguage[] =
    Array.from(
      languageTotals.entries(),
    )
      .map(
        ([name, bytes]) => ({
          name,
          bytes,
        }),
      )
      .sort(
        (a, b) =>
          b.bytes - a.bytes,
      )
      .slice(0, 4);

  const languageWidth =
    Math.max(
      0,
      ...topLanguages.map(
        (language) =>
          language.name.length,
      ),
    );

  /**
   * Languages use 20 sparkles.
   */
  const languageBarUnits =
    allocateBarUnits(
      topLanguages.map(
        (language) =>
          language.bytes,
      ),
      20,
    );

  const languageLines =
    topLanguages.map(
      (language, index) => {
        const percent =
          totalLanguageBytes
            ? (language.bytes /
                totalLanguageBytes) *
              100
            : 0;

        return [
          language.name.padEnd(
            languageWidth,
          ),
          generateSparkleBar(
            languageBarUnits[
              index
            ],
            20,
          ),
          `${percent
            .toFixed(1)
            .padStart(5)}%`,
        ].join(' ');
      },
    );

  /**
   * Time of day.
   */
  const totalCommits =
    morning +
    daytime +
    evening +
    night;

  if (!totalCommits) return;

  const oneDay = [
    {
      label: '🥝 الصباح',
      range: '4am-1pm',
      commits: morning,
    },
    {
      label: '🍊 النهار',
      range: '1pm-5pm',
      commits: daytime,
    },
    {
      label: '🍓 المساء',
      range: '5pm-9pm',
      commits: evening,
    },
    {
      label: '🫐 الليل',
      range: '9pm-4am',
      commits: night,
    },
  ];

  const timeBarUnits =
    allocateBarUnits(
      oneDay.map(
        (period) =>
          period.commits,
      ),
      15,
    );

  const timeCommitWidth =
    Math.max(
      ...oneDay.map(
        (period) =>
          period.commits
            .toString()
            .length,
      ),
    );

  const timeLines =
  oneDay.map(
    (period, index) => {
      const percent =
        (period.commits /
          totalCommits) *
        100;

      return [
        `${period.commits
          .toString()
          .padStart(
            timeCommitWidth,
          )} commits`,
        `${percent
          .toFixed(1)
          .padStart(5)}%`,
        generateSparkleBar(
          timeBarUnits[index],
          15,
        ),
        `\u2066${period.label.split(' ')[0]} ${period.range} ${period.label
          .split(' ')
          .slice(1)
          .join(' ')}\u2069`,
      ].join(' ');
    },
  );

  /**
   * Projects.
   */
  const projectActivity: IProjectActivity[] =
    projects
      .map((project) => {
        const commits =
          repoActivity
            .filter(
              ({ repo }) =>
                project.repos.includes(
                  repo.name,
                ),
            )
            .reduce(
              (
                sum,
                {
                  committedDates,
                },
              ) =>
                sum +
                committedDates.length,
              0,
            );

        return {
          name: project.name,
          commits,
        };
      })
      .filter(
        (project) =>
          project.commits > 0,
      )
      .sort(
        (a, b) =>
          b.commits - a.commits,
      );

  const knownProjectRepos =
    new Set(
      projects.flatMap(
        (project) =>
          project.repos,
      ),
    );

  const otherCommits =
    repoActivity
      .filter(
        ({ repo }) =>
          !knownProjectRepos.has(
            repo.name,
          ),
      )
      .reduce(
        (
          sum,
          { committedDates },
        ) =>
          sum +
          committedDates.length,
        0,
      );

  if (otherCommits > 0) {
    projectActivity.push({
      name: '🧶 other',
      commits: otherCommits,
    });
  }

  const totalProjectCommits =
    projectActivity.reduce(
      (sum, project) =>
        sum +
        project.commits,
      0,
    );

  const projectNameWidth =
    Math.max(
      0,
      ...projectActivity.map(
        (project) =>
          project.name.length,
      ),
    );

  const projectCommitWidth =
    Math.max(
      0,
      ...projectActivity.map(
        (project) =>
          project.commits
            .toString()
            .length,
      ),
    );

  const projectBarUnits =
    allocateBarUnits(
      projectActivity.map(
        (project) =>
          project.commits,
      ),
      15,
    );

  const projectLines =
    projectActivity.map(
      (project, index) => {
        const percent =
          totalProjectCommits
            ? (project.commits /
                totalProjectCommits) *
              100
            : 0;

        return [
          project.name.padEnd(
            projectNameWidth,
          ),
          generateSparkleBar(
            projectBarUnits[
              index
            ],
            15,
          ),
          `${percent
            .toFixed(1)
            .padStart(5)}%`,
          `${project.commits
            .toString()
            .padStart(
              projectCommitWidth,
            )} commits`,
        ].join(' ');
      },
    );

  /**
   * Last five months.
   */
  const monthlyActivity =
    getLastFiveMonths();

  const monthFormatter =
    new Intl.DateTimeFormat(
      'en-US',
      {
        month: 'short',
        year: '2-digit',
        timeZone:
          process.env.TIMEZONE,
      },
    );

  allCommittedDates.forEach(
    ({ committedDate }) => {
      const parts =
        monthFormatter.formatToParts(
          new Date(
            committedDate,
          ),
        );

      const month = parts.find(
        (part) =>
          part.type === 'month',
      )?.value;

      const year = parts.find(
        (part) =>
          part.type === 'year',
      )?.value;

      const key =
        `${year}-${month}`;

      const targetMonth =
        monthlyActivity.find(
          (item) =>
            item.key === key,
        );

      if (targetMonth) {
        targetMonth.commits++;
      }
    },
  );

  const maxMonthlyCommits =
    Math.max(
      0,
      ...monthlyActivity.map(
        (month) =>
          month.commits,
      ),
    );

  const monthlyCommitWidth =
    Math.max(
      1,
      ...monthlyActivity.map(
        (month) =>
          month.commits
            .toString()
            .length,
      ),
    );

  const monthLines =
    monthlyActivity.map(
      (month) => {
        const percentOfMax =
          maxMonthlyCommits
            ? (month.commits /
                maxMonthlyCommits) *
              100
            : 0;

        return [
          month.label.padEnd(7),
          generateBarChart(
            percentOfMax,
            15,
          ),
          `${month.commits
            .toString()
            .padStart(
              monthlyCommitWidth,
            )} commits`,
        ].join(' ');
      },
    );

  /**
   * Combine dashboard columns.
   *
   * Top:
   * Languages | Time of day
   *
   * Bottom:
   * Projects | Last five months
   */
  const topLines =
    combineColumns(
      languageLines,
      timeLines,
    );

  const bottomLines =
    combineColumns(
      projectLines,
      monthLines,
    );

  /**
   * Profile README.
   */
  const owner =
    'laiflonglearner';

  const repo =
    'laiflonglearner';

  const path = 'README.md';

  const readme =
    await octokit.repos
      .getContent({
        owner,
        repo,
        path,
      })
      .catch((error) => {
        console.error(
          `Unable to get profile README\n${error}`,
        );

        return undefined;
      });

  if (
    !readme ||
    Array.isArray(readme.data) ||
    !('content' in readme.data)
  ) {
    console.error(
      'Unable to read profile README',
    );

    return;
  }

  const currentReadme =
    Buffer.from(
      readme.data.content,
      'base64',
    ).toString('utf8');

  const startMarker =
    '<!-- productive-box:start -->';

  const endMarker =
    '<!-- productive-box:end -->';

  const startIndex =
    currentReadme.indexOf(
      startMarker,
    );

  const endIndex =
    currentReadme.indexOf(
      endMarker,
    );

  if (
    startIndex === -1 ||
    endIndex === -1
  ) {
    console.error(
      'Productive box markers not found in README',
    );

    return;
  }

  const currentBlock =
    currentReadme.slice(
      startIndex,
      endIndex +
        endMarker.length,
    );

  const currentStatusMatch =
    currentBlock.match(
      /^### (.+)$/m,
    );

  const currentStatus =
    currentStatusMatch?.[1] ??
    '';

  const nextStatus =
    getRandomStatus(
      morning + daytime >
        evening + night,
      currentStatus,
    );

  /**
   * Generate dashboard.
   *
   * Two normal fenced code blocks:
   *
   * Languages | Time of day
   * Projects  | Last five months
   */
  const generatedBlock = [
    startMarker,
    '<div align="center">',
    '',
    `### ${nextStatus}`,
    '',
    '</div>',
    '',
    '```text',
    ...topLines,
    '```',
    '',
    '```text',
    ...bottomLines,
    '```',
    endMarker,
  ].join('\n');

  const updatedReadme =
    currentReadme.slice(
      0,
      startIndex,
    ) +
    generatedBlock +
    currentReadme.slice(
      endIndex +
        endMarker.length,
    );

  await octokit.repos
    .createOrUpdateFileContents({
      owner,
      repo,
      path,
      message:
        'chore: update productive box',
      content: Buffer.from(
        updatedReadme,
      ).toString('base64'),
      sha: readme.data.sha,
    });

  console.log(
    `Successfully updated productive box: ${nextStatus} 🎉`,
  );
})().catch((error) => {
  console.error(
    'Unable to update productive box',
    error,
  );

  process.exitCode = 1;
});
