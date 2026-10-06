import { Octokit } from '@octokit/rest';
import { config } from 'dotenv';

import { fetchCommittedDates, fetchContributedRepos } from './fetchPaginated.js';
import { daytimeFilenames, nighttimeFilenames } from './filenames.js';
import generateBarChart from './generateBarChart.js';
import githubQuery from './githubQuery.js';
import { userInfoQuery } from './queries.js';

/**
 * Get environment variables.
 */
config({ path: ['.env'] });

interface IRepo {
  name: string;
  owner: string;
}

const getRandomFilename = (
  isDaytime: boolean,
  currentFilename: string,
): string => {
  const filenames = isDaytime ? daytimeFilenames : nighttimeFilenames;

  // Prevent the same filename from appearing twice in a row.
  const available = filenames.filter(
    (filename) => filename !== currentFilename,
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
  ).catch((error) => console.error(`Unable to get the commit info\n${error}`));

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
   * Next, generate diagram.
   */
  const sum = morning + daytime + evening + night;
  if (!sum) return;

  const oneDay = [
    { label: '🥝 الصباح', commits: morning },
    { label: '🍊 النهار', commits: daytime },
    { label: '🍓 المساء', commits: evening },
    { label: '🫐 الليل', commits: night },
  ];

  const lines = oneDay.reduce((prev, cur) => {
    const percent = (cur.commits / sum) * 100;

    const line = [
      `${cur.commits.toString().padStart(5)} commits`.padEnd(14),
      generateBarChart(percent, 21),
      String(percent.toFixed(1)).padStart(5) + '%',
      `\u2066${cur.label}\u2069`,
    ];

    return [...prev, line.join(' ')];
  }, [] as string[]);

  /**
   * Finally, update the Gist.
   */
  const octokit = new Octokit({
    auth: `token ${process.env.GH_TOKEN}`,
  });

  const gist = await octokit.gists
    .get({
      gist_id: `${process.env.GIST_ID}`,
    })
    .catch((error) => console.error(`Unable to get gist\n${error}`));

  if (!gist) return;

  if (!gist.data.files) {
    console.error('No file found in the gist');
    return;
  }

  const currentFilename = Object.keys(gist.data.files)[0];

  const nextFilename = getRandomFilename(
    morning + daytime > evening + night,
    currentFilename,
  );

  await octokit.gists.update({
    gist_id: `${process.env.GIST_ID}`,
    files: {
      [currentFilename]: {
        filename: nextFilename,
        content: lines.join('\n'),
      },
    },
  });

  console.log(`Successfully updated gist: ${nextFilename} 🎉`);
})().catch((error) => {
  console.error('Unable to update gist', error);
  process.exitCode = 1;
});
