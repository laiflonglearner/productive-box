const generateBarChart = (
  percent: number,
  length: number,
): string => {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;

  return '█'.repeat(filled) + '▃'.repeat(empty);
};

export default generateBarChart;
