export interface IRepo {
  name: string;
  owner: string;
}

export interface ILanguage {
  name: string;
  lines: number;
}

export interface ICommitDate {
  committedDate: string;
}

export interface IRepoActivity {
  repo: IRepo;
  committedDates: ICommitDate[];
}

interface IProject {
  name: string;
  repos: string[];
}

export interface IProjectActivity {
  name: string;
  commits: number;
}

export interface IMonthActivity {
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
        label: `${month} ‘${year}`,
        commits: 0,
      };
    },
  );
};

export interface TimeActivity {
  allCommittedDates: ICommitDate[];
  morning: number;
  daytime: number;
  evening: number;
  night: number;
}

export const getTimeActivity = (repoActivity: IRepoActivity[]): TimeActivity => {
  const allCommittedDates =
    repoActivity.flatMap(
      ({ committedDates }) =>
        committedDates,
    );

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

  return { allCommittedDates, morning, daytime, evening, night };
};

export interface DashboardStats {
  language: { totalLines: number; top: ILanguage[] };
  time: TimeActivity;
  projects: IProjectActivity[];
  totalProjectCommits: number;
  months: IMonthActivity[];
}

export const getDashboardStats = (
  repoActivity: IRepoActivity[],
  languageTotals: Map<string, number>,
  time: TimeActivity,
): DashboardStats => {
  const totalLanguageLines = Array.from(languageTotals.values()).reduce(
    (sum, lines) => sum + lines,
    0,
  );
  const topLanguages: ILanguage[] = Array.from(languageTotals.entries())
    .map(([name, lines]) => ({ name, lines }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 4);
  const projectActivity: IProjectActivity[] = projects
    .map((project) => ({
      name: project.name,
      commits: repoActivity
        .filter(({ repo }) => project.repos.includes(repo.name))
        .reduce((sum, { committedDates }) => sum + committedDates.length, 0),
    }))
    .filter((project) => project.commits > 0)
    .sort((a, b) => b.commits - a.commits);
  const knownProjectRepos = new Set(projects.flatMap((project) => project.repos));
  const otherCommits = repoActivity
    .filter(({ repo }) => !knownProjectRepos.has(repo.name))
    .reduce((sum, { committedDates }) => sum + committedDates.length, 0);
  if (otherCommits > 0) {
    projectActivity.push({
      name: '🧶 other',
      commits: otherCommits,
    });
  }
  const totalProjectCommits = projectActivity.reduce(
    (sum, project) => sum + project.commits,
    0,
  );
  const monthlyActivity = getLastFiveMonths();
  const monthFormatter = new Intl.DateTimeFormat(
    'en-US',
    {
      month: 'short',
      year: '2-digit',
      timeZone: process.env.TIMEZONE,
    },
  );

  for (const { committedDate } of time.allCommittedDates) {
    const parts = monthFormatter.formatToParts(new Date(committedDate));
    const month = parts.find((part) => part.type === 'month')?.value;
    const year = parts.find((part) => part.type === 'year')?.value;
    const targetMonth = monthlyActivity.find((item) => item.key === year + '-' + month);
    if (targetMonth) targetMonth.commits++;
  }

  return {
    language: { totalLines: totalLanguageLines, top: topLanguages },
    time,
    projects: projectActivity,
    totalProjectCommits,
    months: monthlyActivity,
  };
};
