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
  /**
   * First, get user ID.
   */
  const userResponse = await githubQuery(userInfoQuery).catch((error) =>
    console.error(`Unable to get username and id\n${error}`),
  );
  const { login: username, id } = userResponse?.data?.viewer ?? {};

  if (!username || !id) return;

  /**
   * Second, get contributed repos.
   */
  const repoInfos = await fetchContributedRepos(username).catch((error) =>
    console.error(`Unable to get the contributed repo\n${error}`),
  );
  if (!repoInfos) return;

  const repos: IRepo[] = repoInfos
    .filter((repoInfo) => !repoInfo?.isFork)
    .map((repoInfo) => ({
      name: repoInfo?.name,
      owner: repoInfo?.owner?.login,
    }));

  /**
   * Third, get commit times and group by time of day.
   */
  const committedDatesByRepo = await Promise.all(
    repos.map(({ name, owner }) => fetchCommittedDates(id, name, owner)),
  ).catch((error) =>
    console.error(`Unable to get the commit info\n${error}`),
  );

  if (!committedDatesByRepo) return;

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
   * Generate diagram.
   */
  const sum = morning + daytime + evening + night;
  if (!sum) return;

  const oneDay = [
    { label: '🥝 الصباح', range: '4-12', commits: morning },
    { label: '🍊 النهار', range: '12-17', commits: daytime },
    { label: '🍓 المساء', range: '17-21', commits: evening },
    { label: '🫐 الليل', range: '21-4', commits: night },
  ];

  const lines = oneDay.reduce((prev, cur) => {
    const percent = (cur.commits / sum) * 100;

    const line = [
      `${cur.commits.toString().padStart(5)} commits`.padEnd(14),
      cur.range.padEnd(5),
      generateBarChart(percent, 21),
      String(percent.toFixed(1)).padStart(5) + '%',
      `\u2066${cur.label}\u2069`,
    ];

    return [...prev, line.join(' ')];
  }, [] as string[]);

  /**
   * Get profile README.
   */
  const octokit = new Octokit({
    auth: `token ${process.env.GH_TOKEN}`,
  });

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
   * Find the current rotating status.
   */
  const startMarker = '<!-- productive-box:start -->';
  const endMarker = '<!-- productive-box:end -->';

  const startIndex = currentContent.indexOf(startMarker);
  const endIndex = currentContent.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    console.error('README.md is missing the productive-box markers');
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

  console.log(`Successfully updated productive-box: ${nextStatus} 🎉`);
})().catch((error) => {
  console.error('Unable to update productive-box', error);
  process.exitCode = 1;
});
