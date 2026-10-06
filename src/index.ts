
import { Octokit } from '@octokit/rest';
import { config } from 'dotenv';

import { fetchCommittedDates, fetchContributedRepos } from './fetchPaginated.js';
import generateBarChart from './generateBarChart.js';
import githubQuery from './githubQuery.js';
import { userInfoQuery } from './queries.js';
import {
  getNextFilename,
  initialState,
  STATE_FILENAME,
  type RotationState,
} from './rotateFilename.js';

/**
 * Get environment variables.
 */
config({ path: ['.env'] });

interface IRepo {
  name: string;
  owner: string;
}

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
   * Finally, update the Gist and filename rotation.
   */
  const octokit = new Octokit({ auth: process.env.GH_TOKEN });
  const gistId = process.env.GIST_ID;

  if (!gistId) {
    throw new Error('GIST_ID is missing');
  }

  const { data: gist } = await octokit.gists.get({
    gist_id: gistId,
  });

  const files = gist.files;

  if (!files) {
    throw new Error('No files found in the gist');
  }

  /**
   * Load the previous rotation state, if available.
   */
  let state: RotationState = initialState();

  const stateFile = files[STATE_FILENAME];

  if (stateFile) {
    let content = stateFile.content;

    // Gist responses may omit content for truncated files.
    if (stateFile.truncated || typeof content !== 'string') {
      if (!stateFile.raw_url) {
        throw new Error('Rotation state content is unavailable');
      }

      const response = await fetch(stateFile.raw_url);

      if (!response.ok) {
        throw new Error('Unable to fetch rotation state');
      }

      content = await response.text();
    }

    const parsed: unknown = JSON.parse(content);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('daytime' in parsed) ||
      !('nighttime' in parsed) ||
      !Array.isArray(parsed.daytime) ||
      !Array.isArray(parsed.nighttime) ||
      !parsed.daytime.every((item: unknown) => typeof item === 'string') ||
      !parsed.nighttime.every((item: unknown) => typeof item === 'string')
    ) {
      throw new Error('Invalid rotation state');
    }

    state = {
      daytime: parsed.daytime,
      nighttime: parsed.nighttime,
    };
  }

  /**
   * Find the existing diagram, excluding the state file.
   */
  const filename = Object.keys(files).find(
    (name) => name !== STATE_FILENAME,
  );

  if (!filename) {
    throw new Error('No diagram file found in the gist');
  }

  /**
   * Select the animal and its next unused phrase.
   */
  const period =
    morning + daytime > evening + night ? 'daytime' : 'nighttime';

  const nextFilename = getNextFilename(period, state);

  /**
   * Update both files in the same Gist request.
   */
  await octokit.gists.update({
    gist_id: gistId,
    files: {
      [filename]: {
        filename: nextFilename,
        content: lines.join('\n'),
      },
      [STATE_FILENAME]: {
        content: JSON.stringify(state, null, 2),
      },
    },
  });

  console.log(`Successfully updated gist: ${nextFilename} 🎉`);
})().catch((error) => {
  console.error('Unable to update gist', error);
  process.exitCode = 1;
});
