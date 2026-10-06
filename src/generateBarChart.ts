export default function generateBarChart(
  percent: number,
  length: number,
): string {
  const filled = Math.round(
    (percent / 100) * length,
  );

  return (
    '✦'.repeat(filled) +
    '✧'.repeat(length - filled)
  );
}
