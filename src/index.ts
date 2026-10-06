import { Octokit } from '@octokit/rest';
import { config } from 'dotenv';

import { fetchCommittedDates, fetchContributedRepos } from './fetchPaginated.js';
import { daytimeFilenames, nighttimeFilenames } from './filenames.js';
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

const getRandomStatus = (
  isDaytime: boolean,
  currentStatus: string,
): string => {
  const statuses = isDaytime ? daytimeFilenames : nighttimeFilenames;

  const available = statuses.filter(
    (status) => status !== currentStatus,
  );

  return available[Math.floor(Math.random() * available.length)];
};

(async () => {
  const octokit = new Octokit({
    auth: `token ${process.env.GH_TOKEN}`,
  });

  /**
   * Get user ID.
   */
  const userResponse = await githubQuery(userInfoQuery).catch((error) =>
    console.error(`Unable to get username and id\n${error}`),
  );

  const { login: username, id } = userResponse?.data?.viewer ?? {};

  if (!username || !id) return;

  /**
   * Get contributed repos.
   */
  const repoInfos = await fetchContributedRepos(username).catch((error) =>
    console.error(`Unable to get the contributed repos\n${error}`),
  );

  if (!repoInfos) return;

  const repos: IRepo[] = repoInfos
    .filter((repoInfo) => !repoInfo?.isFork)
    .map((repoInfo) => ({
      name: repoInfo?.name,
      owner: repoInfo?.owner?.login,
    }));

  /**
   * Get commit times and language data.
   */
  const [committedDatesByRepo, languagesByRepo] = await Promise.all([
    Promise.all(
      repos.map(({ name, owner }) =>
        fetchCommittedDates(id, name, owner),
      ),
    ),
    Promise.all(
      repos.map(({ name, owner }) =>
        octokit.repos
          .listLanguages({
            owner,
            repo: name,
          })
          .then((response) => response.data)
          .catch((error) => {
            console.error(
              `Unable to get languages for ${owner}/${name}\n${error}`,
            );

            return {};
          }),
      ),
    ),
  ]).catch((error) => {
    console.error(`Unable to get GitHub activity\n${error}`);
    return [];
  });

  if (!committedDatesByRepo || !languagesByRepo) return;

  /**
   * Group commits by time of day.
   */
  let morning = 0; // 4 - 12
  let daytime = 0; // 12 - 17
  let evening = 0; // 17 - 21
  let night = 0; // 21 - 4

  committedDatesByRepo.forEach((committedDates) => {
    committedDates.forEach(({ committedDate }) => {
      const hour = Number(
        new Date(committedDate)
          .toLocaleTimeString('en-US', {
            hourCycle: 'h23',
            timeZone: process.env.TIMEZONE,
          })
          .split(':')[0],
      );

      if (hour >= 4 && hour < 12) morning++;
      if (hour >= 12 && hour < 17) daytime++;
      if (hour >= 17 && hour < 21) evening++;
      if (hour >= 21 || hour < 4) night++;
    });
  });

  /**
   * Aggregate languages across repositories.
   */
  const languageTotals = new Map<string, number>();

  languagesByRepo.forEach((languages) => {
    Object.entries(languages).forEach(([language, bytes]) => {
      languageTotals.set(
        language,
        (languageTotals.get(language) ?? 0) + bytes,
      );
    });
  });

  const totalLanguageBytes = Array.from(
    languageTotals.values(),
  ).reduce((sum, bytes) => sum + bytes, 0);

  const topLanguages: ILanguage[] = Array.from(
    languageTotals.entries(),
  )
    .map(([name, bytes]) => ({
      name,
      bytes,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 4);

  /**
   * Generate commit diagram.
   */
  const totalCommits = morning + daytime + evening + night;

  if (!totalCommits) return;

  const oneDay = [
    { label: '🥝 الصباح', range: '4-12', commits: morning },
    { label: '🍊 النهار', range: '12-17', commits: daytime },
    { label: '🍓 المساء', range: '17-21', commits: evening },
    { label: '🫐 الليل', range: '21-4', commits: night },
  ];

  /**
   * Generate four aligned rows:
   *
   * commit stats | language stats
   */
  const lines = oneDay.map((period, index) => {
    const commitPercent =
      (period.commits / totalCommits) * 100;

    const commitSection = [
      `${period.commits.toString().padStart(5)} commits`.padEnd(14),
      period.range.padEnd(5),
      generateBarChart(commitPercent, 21),
      `${commitPercent.toFixed(1).padStart(5)}%`,
      `\u2066${period.label}\u2069`,
    ].join(' ');

    const language = topLanguages[index];

    if (!language || !totalLanguageBytes) {
      return commitSection;
    }

    const languagePercent =
      (language.bytes / totalLanguageBytes) * 100;

    const languageSection = [
      language.name.padEnd(12),
      generateBarChart(languagePercent, 14),
      `${languagePercent.toFixed(1).padStart(5)}%`,
    ].join(' ');

    return `${commitSection}    ${languageSection}`;
  });

  /**
   * Get profile README.
   */
  const owner = 'laiflonglearner';
  const repo = 'laiflonglearner';
  const path = 'README.md';

  const readme = await octokit.repos
    .getContent({
      owner,
      repo,
      path,
    })
    .catch((error) =>
      console.error(`Unable to get profile README\n${error}`),
    );

  if (!readme) return;

  if (Array.isArray(readme.data) || !('content' in readme.data)) {
    console.error('README.md could not be read');
    return;
  }

  const currentContent = Buffer.from(
    readme.data.content,
    'base64',
  ).toString('utf8');

  /**
   * Find productive-box section.
   */
  const startMarker = '<!-- productive-box:start -->';
  const endMarker = '<!-- productive-box:end -->';

  const startIndex = currentContent.indexOf(startMarker);
  const endIndex = currentContent.indexOf(endMarker);

  if (
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex < startIndex
  ) {
    console.error(
      'README.md is missing the productive-box markers',
    );

    return;
  }

  const currentBlock = currentContent.slice(
    startIndex + startMarker.length,
    endIndex,
  );

  const currentStatus =
    currentBlock.match(/^### (.+)$/m)?.[1]?.trim() ?? '';

  const nextStatus = getRandomStatus(
    morning + daytime > evening + night,
    currentStatus,
  );

  /**
   * Generate productive-box section.
   */
  const generated = [
    startMarker,
    `### ${nextStatus}`,
    '',
    '```text',
    ...lines,
    '```',
    endMarker,
  ].join('\n');

  const nextContent =
    currentContent.slice(0, startIndex) +
    generated +
    currentContent.slice(endIndex + endMarker.length);

  /**
   * Update profile README.
   */
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message: 'chore: update productive box',
    content: Buffer.from(nextContent).toString('base64'),
    sha: readme.data.sha,
  });

  console.log(
    `Successfully updated productive-box: ${nextStatus} 🎉`,
  );
})().catch((error) => {
  console.error('Unable to update productive-box', error);
  process.exitCode = 1;
});
