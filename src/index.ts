const oneDay = [
  { label: '🥝 الصباح', range: '04-12', commits: morning },
  { label: '🍊 النهار', range: '12-17', commits: daytime },
  { label: '🍓 المساء', range: '17-21', commits: evening },
  { label: '🫐 الليل', range: '21-04', commits: night },
];

const commitWidth = Math.max(
  ...oneDay.map((period) => period.commits.toString().length),
);

const languageWidth = Math.max(
  ...topLanguages.map((language) => language.name.length),
);

const lines = oneDay.map((period, index) => {
  const commitPercent =
    (period.commits / totalCommits) * 100;

  const commitSection = [
    `${period.commits.toString().padStart(commitWidth)} commits`,
    period.range,
    generateBarChart(commitPercent, 21),
    `${commitPercent.toFixed(1).padStart(5)}%`,
    `\u2066${period.label}\u2069`,
  ].join('  ');

  const language = topLanguages[index];

  if (!language || !totalLanguageBytes) {
    return commitSection;
  }

  const languagePercent =
    (language.bytes / totalLanguageBytes) * 100;

  const languageSection = [
    language.name.padEnd(languageWidth),
    generateBarChart(languagePercent, 14),
    `${languagePercent.toFixed(1).padStart(5)}%`,
  ].join('  ');

  return `${commitSection}    ${languageSection}`;
});
