export function treasuryContext(history, asOfDate) {
  const points = history
    .map((point) => Array.isArray(point) ? { date: point[0], value: point[1] } : point)
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value) && point.date <= asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = points.at(-1);
  const year = String(asOfDate).slice(0, 4);
  const result = { year, latest: latest || null, baseline: null, changeBp: null, historicalPeaks: [] };
  if (!latest || !latest.date.startsWith(year)) return result;
  const yearStart = `${year}-01-01`;
  const baseline = points.filter((point) => point.date < yearStart).at(-1);
  const day = 86400000;
  if (baseline && Date.parse(yearStart) - Date.parse(baseline.date) <= 15 * day) {
    result.baseline = baseline;
    result.changeBp = Math.round((latest.value - baseline.value) * 10000) / 100;
  }
  const annual = new Map();
  for (const point of points) {
    const pointYear = Number(point.date.slice(0, 4));
    let record = annual.get(pointYear);
    if (!record) {
      record = { year: pointYear, first: point, last: point, peak: point, hasLongGap: false };
      annual.set(pointYear, record);
    }
    if (Date.parse(point.date) - Date.parse(record.last.date) > 45 * day) record.hasLongGap = true;
    if (point.value > record.peak.value) record.peak = point;
    record.last = point;
  }
  const complete = (record) => record && record.year < Number(year) && !record.hasLongGap
    && Date.parse(record.first.date) - Date.parse(`${record.year}-01-01`) <= 15 * day
    && Date.parse(`${record.year}-12-31`) - Date.parse(record.last.date) <= 15 * day;
  const peaks = [...annual.values()]
    .filter((record) => {
      const before = annual.get(record.year - 1);
      const after = annual.get(record.year + 1);
      return complete(record) && complete(before) && complete(after)
        && record.peak.value > before.peak.value && record.peak.value >= after.peak.value;
    })
    .map((record) => ({
      year: record.year, date: record.peak.date, value: record.peak.value,
      differenceBp: Math.round((latest.value - record.peak.value) * 10000) / 100,
    }));
  const above = peaks.filter((peak) => peak.differenceBp <= 0);
  result.historicalPeaks = (above.length ? above : peaks)
    .sort((a, b) => Math.abs(a.differenceBp) - Math.abs(b.differenceBp) || b.year - a.year)
    .slice(0, 2);
  return result;
}
