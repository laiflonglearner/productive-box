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

  const pool = available.length ? available : statuses;

  return pool[Math.floor(Math.random() * pool.length)];
};

(async () => {
  const octokit = new Octokit({
    auth: `token ${process.env.GH_TOKEN}`,
  });

  /**
   * Get user ID and username.
   */
  const userResponse = await githubQuery(userInfoQuery).catch((error) =>
    console.error(`Unable to get username and id\n${error}`),
  );

  const { login: username, id } = userResponse?.data?.viewer ?? {};

  if (!username || !id) return;

  /**
   * Get contributed repositories.
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
   * Get commit dates and language data.
   */
  let committedDatesByRepo;
  let languagesByRepo;

  try {
    [committedDatesByRepo, languagesByRepo] = await Promise.all([
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
    ]);
  } catch (error) {
    console.error(`Unable to get GitHub activity\n${error}`);
    return;
  }

  /**
   * Group commits by time of day.
   */
  let morning = 0;
  let daytime = 0;
  let evening = 0;
  let night = 0;

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
   * Aggregate language bytes across repositories.
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
   * Prepare commit statistics.
   */
  const totalCommits = morning + daytime + evening + night;

  if (!totalCommits) return;

  const oneDay = [
    {
      label: '🥝 الصباح',
      range: '04-12',
      commits: morning,
    },
    {
      label: '🍊 النهار',
      range: '12-17',
      commits: daytime,
    },
    {
      label: '🍓 المساء',
      range: '17-21',
      commits: evening,
    },
    {
      label: '🫐 الليل',
      range: '21-04',
      commits: night,
    },
  ];

  const commitWidth = Math.max(
    ...oneDay.map((period) => period.commits.toString().length),
  );

  const languageWidth = Math.max(
    ...topLanguages.map((language) => language.name.length),
  );

  /**
   * Generate README lines.
   *
   * Languages stay on the left so all fixed-width LTR content
   * comes before the Arabic labels.
   */
  const lines = oneDay.map((period, index) => {
    const commitPercent =
      (period.commits / totalCommits) * 100;

    const language = topLanguages[index];

    let languageSection = '';

    if (language && totalLanguageBytes) {
      const languagePercent =
        (language.bytes / totalLanguageBytes) * 100;

      languageSection = [
        language.name.padEnd(languageWidth),
        generateBarChart(languagePercent, 25),
        `${languagePercent.toFixed(1).padStart(5)}%`,
      ].join(' ');
    }

    const commitSection = [
      `${period.commits
        .toString()
        .padStart(commitWidth)} commits`,
      period.range,
      generateBarChart(commitPercent, 25),
      `${commitPercent.toFixed(1).padStart(5)}%`,
      `\u2066${period.label}\u2069`,
    ].join(' ');

    return `${languageSection}    ${commitSection}`;
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
    .catch((error) => {
      console.error(`Unable to get profile README\n${error}`);
      return undefined;
    });

  if (!readme || Array.isArray(readme.data) || !('content' in readme.data)) {
    console.error('Unable to read profile README');
    return;
  }

  const currentReadme = Buffer.from(
    readme.data.content,
    'base64',
  ).toString('utf8');

  const startMarker = '<!-- productive-box:start -->';
  const endMarker = '<!-- productive-box:end -->';

  const startIndex = currentReadme.indexOf(startMarker);
  const endIndex = currentReadme.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    console.error('Productive box markers not found in README');
    return;
  }

  /**
   * Get current rotating status so it does not repeat.
   */
  const currentBlock = currentReadme.slice(
    startIndex,
    endIndex + endMarker.length,
  );

  const currentStatusMatch = currentBlock.match(/^### (.+)$/m);

  const currentStatus = currentStatusMatch?.[1] ?? '';

  const nextStatus = getRandomStatus(
    morning + daytime > evening + night,
    currentStatus,
  );

  /**
   * Generate the new productive-box block.
   *
   * The heading is centered, while the code block remains left-aligned.
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
    ...lines,
    '```',
    endMarker,
  ].join('\n');

  const updatedReadme =
    currentReadme.slice(0, startIndex) +
    generatedBlock +
    currentReadme.slice(endIndex + endMarker.length);

  /**
   * Update profile README.
   */
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message: 'chore: update productive box',
    content: Buffer.from(updatedReadme).toString('base64'),
    sha: readme.data.sha,
  });

  console.log(`Successfully updated productive box: ${nextStatus} 🎉`);
})().catch((error) => {
  console.error('Unable to update productive box', error);
  process.exitCode = 1;
});
