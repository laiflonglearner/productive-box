import generateBarChart from './generateBarChart.js';
import { daytimeFilenames, nighttimeFilenames } from './filenames.js';
import type { DashboardStats, TimeActivity } from './dashboardStats.js';

export const PRODUCTIVE_BOX_START_MARKER = '<!-- productive-box:start -->';
export const PRODUCTIVE_BOX_END_MARKER = '<!-- productive-box:end -->';

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

const combineColumns = (
  leftLines: string[],
  rightLines: string[],
  gap = 8,
): string[] => {
  const leftWidth = Math.max(0, ...leftLines.map((line) => line.length));
  const rowCount = Math.max(leftLines.length, rightLines.length);

  return Array.from({ length: rowCount }, (_, index) => {
    const left = leftLines[index] ?? '';
    const right = rightLines[index] ?? '';
    return `${left.padEnd(leftWidth)}${' '.repeat(gap)}${right}`;
  });
};

const toBoldUnicode = (value: string): string =>
  [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (code >= 65 && code <= 90) return String.fromCodePoint(0x1d5d4 + code - 65);
      if (code >= 97 && code <= 122) return String.fromCodePoint(0x1d5ee + code - 97);
      return character;
    })
    .join('');

const getLanguageLines = (
  language: DashboardStats['language'],
): string[] => {
  const languageWidth = Math.max(0, ...language.top.map((item) => item.name.length));
  const languageBarUnits = allocateBarUnits(language.top.map((item) => item.lines), 18);
  const languageLines = language.top.map((item, index) => {
    const percent = language.totalLines ? (item.lines / language.totalLines) * 100 : 0;
    return [
      item.name.padEnd(languageWidth),
      generateSparkleBar(languageBarUnits[index], 18),
      `${percent.toFixed(1).padStart(5)}%`,
    ].join(' ');
  });
  if (!languageLines.length) languageLines.push('No attributed code found.');
  return languageLines;
};

const getTimeLines = (activity: TimeActivity): string[] => {
  const { morning, daytime, evening, night } = activity;
  const totalCommits = morning + daytime + evening + night;
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

  const timeLines = oneDay.map((period, index) => {
    const percent = totalCommits ? (period.commits / totalCommits) * 100 : 0;

    return [
      `${period.commits.toString().padStart(timeCommitWidth)} commits`,
      `${percent.toFixed(1).padStart(5)}%`,
      generateSparkleBar(timeBarUnits[index], 15),
      `\u2066${period.label.split(' ')[0]} ${period.range} ${period.label.split(' ').slice(1).join(' ')}\u2069`,
    ].join(' ');
  });

  return timeLines;
};

const getProjectLines = (
  projects: DashboardStats['projects'],
  totalProjectCommits: number,
): string[] => {
  const projectNameWidth = Math.max(0, ...projects.map((project) => project.name.length));
  const projectCommitWidth = Math.max(0, ...projects.map((project) => project.commits.toString().length));
  const projectBarUnits = allocateBarUnits(projects.map((project) => project.commits), 15);
  return projects.map((project, index) => {
    const percent = totalProjectCommits ? (project.commits / totalProjectCommits) * 100 : 0;
    return [
      project.name.padEnd(projectNameWidth),
      generateSparkleBar(projectBarUnits[index], 15),
      `${percent.toFixed(1).padStart(5)}%`,
      `${project.commits.toString().padStart(projectCommitWidth)} commits`,
    ].join(' ');
  });
};

const getMonthLines = (
  months: DashboardStats['months'],
): string[] => {
  const maxMonthlyCommits = Math.max(0, ...months.map((month) => month.commits));
  const monthlyCommitWidth = Math.max(1, ...months.map((month) => month.commits.toString().length));
  return months.map((month) => {
    const percentOfMax = maxMonthlyCommits ? (month.commits / maxMonthlyCommits) * 100 : 0;
    return [
      month.label.padEnd(7),
      generateBarChart(percentOfMax, 15),
      `${month.commits.toString().padStart(monthlyCommitWidth)} commits`,
    ].join(' ');
  });
};

export interface RenderedDashboard {
  block: string;
  status: string;
}

export const renderDashboardBlock = (
  stats: DashboardStats,
  currentStatus: string,
): RenderedDashboard => {
  const { language, time, projects, totalProjectCommits, months } = stats;
  const languageLines = getLanguageLines(language);
  const timeLines = getTimeLines(time);
  const projectLines = getProjectLines(projects, totalProjectCommits);
  const monthLines = getMonthLines(months);
  const { morning, daytime, evening, night } = time;
  const totalCommits = morning + daytime + evening + night;
  const nextStatus =
    !totalCommits && currentStatus
      ? currentStatus
      : getRandomStatus(morning + daytime > evening + night, currentStatus);
  const shiftHeader = (header: string, spaces: number) => `${' '.repeat(spaces)}𖧷──〢${toBoldUnicode(header)}`;
  const topLines = combineColumns(
    [`𖧷──〢${toBoldUnicode('language stack')}`, ...languageLines],
    [shiftHeader('peak hours this year', 22), ...timeLines],
  );

  const bottomLines = combineColumns(
    [`𖧷──〢${toBoldUnicode('stuff i’ve been building')}`, ...projectLines],
    [shiftHeader('how it’s been going', 29), ...monthLines],
  );

  const generatedBlock = [
    PRODUCTIVE_BOX_START_MARKER,
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
    PRODUCTIVE_BOX_END_MARKER,
  ].join('\n');
  return { block: generatedBlock, status: nextStatus };
};
