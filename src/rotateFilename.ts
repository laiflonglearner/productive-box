
import { daytimeFilenames, nighttimeFilenames } from './filenames.js';

export const STATE_FILENAME = 'rotation-state.json';

export interface RotationState {
  daytime: string[];
  nighttime: string[];
}

export const initialState = (): RotationState => ({
  daytime: [],
  nighttime: [],
});

const shuffle = <T>(items: readonly T[]): T[] => {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
};

export const getNextFilename = (
  period: keyof RotationState,
  state: RotationState,
): string => {
  const filenames =
    period === 'daytime' ? daytimeFilenames : nighttimeFilenames;

  // Keep only valid, unused phrases from the previous rotation.
  const remaining = [...new Set(state[period])].filter((name) =>
    filenames.includes(name),
  );

  // Once exhausted, begin a new randomly shuffled cycle.
  if (remaining.length === 0) {
    remaining.push(...shuffle(filenames));
  }

  const filename = remaining.shift();

  if (!filename) {
    throw new Error(`No filenames available for ${period}`);
  }

  state[period] = remaining;

  return filename;
};
