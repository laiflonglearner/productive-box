/**
 * clone from https://github.com/matchai/waka-box
 * modified to draw whole cells only, see the commit message for why
 */
export default function generateBarChart(percent: number, size: number) {
  const filled = Math.min(size, Math.round((size * percent) / 100));

  return '█'.repeat(filled).padEnd(size, '░');
}
