export const RATE_SCHEMA_VERSION = 1;

export const RATE_SERIES_KEYS = ["us2y", "us10y", "us30y", "cn10y"];

// Official Choice EDB directory, exact original names and upstream publishers.
export const CHOICE_RATE_SERIES_IDS = Object.freeze({
  us2y: "E1003234", us10y: "E1003238", us30y: "E1003240", cn10y: "E1002649",
});

export const RATE_SERIES_CONFIG = {
  us2y: {
    name: "美国2年期国债收益率",
    source: "美联储",
    unit: "%",
    indicator: "美国:国债收益率:2年(%)",
  },
  us10y: {
    name: "美国10年期国债收益率",
    source: "美联储",
    unit: "%",
    indicator: "美国:国债收益率:10年(%)",
  },
  us30y: {
    name: "美国30年期国债收益率",
    source: "美联储",
    unit: "%",
    indicator: "美国:国债收益率:30年(%)",
  },
  cn10y: {
    name: "中国10年期国债到期收益率",
    source: "中国外汇交易中心",
    unit: "%",
    indicator: "国债到期收益率:10年(%)",
  },
};

const LEGACY_RATE_SOURCE = {
  provider: "妙想 MCP（东方财富数据库）",
  tool: "mx_macro_data",
  endpoint: "https://mxapi.eastmoney.com/mxds/mcp",
  series: Object.fromEntries(
    RATE_SERIES_KEYS.map((key) => [key, RATE_SERIES_CONFIG[key].source]),
  ),
};

export const RATE_SOURCE = {
  provider: "Choice量化API（东方财富数据库）",
  tool: "Choice.edb",
  endpoint: "https://quantapi.eastmoney.com/",
  series: Object.fromEntries(RATE_SERIES_KEYS.map((key) => [key, RATE_SERIES_CONFIG[key].source])),
  indicators: CHOICE_RATE_SERIES_IDS,
};

export const RATE_SPREAD_META = {
  name: "中美10年期国债利差",
  formula: "美国10年期国债收益率减中国10年期国债到期收益率",
  unit: "bp",
};

export const RATE_ALIGNMENT_METHOD = "仅使用美国10年期与中国10年期均有观测的同一日期计算利差，不对休市日做前向填充";

const MIN_ANNUAL_OBSERVATIONS = 180;
const MAX_ANNUAL_BOUNDARY_LAG_DAYS = 14;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, scope) {
  if (!isPlainObject(value)) fail(`${scope}必须是对象`);
}

function assertExactKeys(value, expected, scope) {
  assertPlainObject(value, scope);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${scope}字段异常，实际字段为 ${actual.join("、")}`);
  }
}

export function parseIsoDate(value, scope = "日期") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${scope}必须使用 YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    fail(`${scope}无效 ${value}`);
  }
  return value;
}

export function calendarDayDifference(later, earlier) {
  parseIsoDate(later, "较晚日期");
  parseIsoDate(earlier, "较早日期");
  return Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000,
  );
}

function parseIsoTimestamp(value, scope) {
  if (typeof value !== "string") fail(`${scope}必须是 ISO 时间字符串`);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    fail(`${scope}必须是标准 UTC ISO 时间 ${value}`);
  }
  return value;
}

function parseRateValue(value, scope) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${scope}不是有限数字`);
    if (value < -10 || value > 30) fail(`${scope}超出收益率合理范围 ${value}`);
    return value;
  }

  if (typeof value !== "string") fail(`${scope}格式错误`);
  const raw = value.trim();
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) fail(`${scope}格式错误 ${value}`);
  const number = Number(raw);
  if (!Number.isFinite(number) || number < -10 || number > 30) {
    fail(`${scope}超出收益率合理范围 ${value}`);
  }
  return number;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function identifySeries(indicator, source, scope) {
  if (typeof indicator !== "string" || typeof source !== "string") {
    fail(`${scope}指标名或数据来源不是字符串`);
  }
  const normalizedIndicator = indicator.replace(/\s+/g, "").replaceAll("：", ":");
  const normalizedSource = source.trim();
  const matches = RATE_SERIES_KEYS.filter((key) => (
    RATE_SERIES_CONFIG[key].indicator === normalizedIndicator
      && RATE_SERIES_CONFIG[key].source === normalizedSource
  ));
  if (matches.length !== 1) {
    fail(`${scope}无法唯一识别指标 ${indicator}，数据来源为 ${source}`);
  }
  return matches[0];
}

export function parseMacroRatePayload(payload, { start, end, scope = "妙想年度利率查询" }) {
  parseIsoDate(start, `${scope}开始日期`);
  parseIsoDate(end, `${scope}结束日期`);
  if (start > end) fail(`${scope}开始日期晚于结束日期`);
  if (!isPlainObject(payload) || !Array.isArray(payload.data) || payload.data.length !== 1) {
    fail(`${scope}必须只返回一张表`);
  }

  const [table] = payload.data;
  if (!isPlainObject(table) || !Array.isArray(table.columns) || !Array.isArray(table.items)) {
    fail(`${scope}表结构错误`);
  }
  if (table.columns.length < 3) fail(`${scope}没有日期列`);
  if (table.columns[0] !== "利率（日）" || table.columns[1] !== "数据来源") {
    fail(`${scope}前两列应为利率（日）和数据来源`);
  }

  const dates = table.columns.slice(2).map((value, index) => {
    const date = parseIsoDate(value, `${scope}第${index + 3}列表头`);
    if (date < start || date > end) fail(`${scope}返回区间外日期 ${date}`);
    return date;
  });
  if (new Set(dates).size !== dates.length) fail(`${scope}含有重复日期列`);
  if (table.items.length !== RATE_SERIES_KEYS.length) {
    fail(`${scope}应返回四行指标，实际为 ${table.items.length} 行`);
  }

  const parsed = Object.fromEntries(RATE_SERIES_KEYS.map((key) => [key, []]));
  const seen = new Set();
  for (const [rowIndex, row] of table.items.entries()) {
    if (!Array.isArray(row) || row.length !== table.columns.length) {
      fail(`${scope}第${rowIndex + 1}行列数错误`);
    }
    const key = identifySeries(row[0], row[1], `${scope}第${rowIndex + 1}行`);
    if (seen.has(key)) fail(`${scope}指标 ${key} 重复`);
    seen.add(key);

    for (let index = 0; index < dates.length; index += 1) {
      const raw = row[index + 2];
      if (raw === "-") continue;
      parsed[key].push({
        date: dates[index],
        value: parseRateValue(raw, `${scope}.${key}.${dates[index]}`),
      });
    }
    parsed[key].sort((left, right) => left.date.localeCompare(right.date));
    if (parsed[key].length < MIN_ANNUAL_OBSERVATIONS) {
      fail(`${scope}.${key}只有${parsed[key].length}个有效观测，疑似返回被截断`);
    }
    const firstDate = parsed[key][0].date;
    const lastDate = parsed[key].at(-1).date;
    if (calendarDayDifference(firstDate, start) > MAX_ANNUAL_BOUNDARY_LAG_DAYS) {
      fail(`${scope}.${key}首个有效观测 ${firstDate} 距区间开始日超过${MAX_ANNUAL_BOUNDARY_LAG_DAYS}天`);
    }
    if (calendarDayDifference(end, lastDate) > MAX_ANNUAL_BOUNDARY_LAG_DAYS) {
      fail(`${scope}.${key}最后有效观测 ${lastDate} 距区间结束日超过${MAX_ANNUAL_BOUNDARY_LAG_DAYS}天`);
    }
  }

  if (seen.size !== RATE_SERIES_KEYS.length) fail(`${scope}指标不完整`);
  return parsed;
}

export function parseChoiceRatePayload(payload, {
  start, end, scope = "Choice年度利率查询", minimumObservations = MIN_ANNUAL_OBSERVATIONS,
  maximumBoundaryLagDays = MAX_ANNUAL_BOUNDARY_LAG_DAYS,
}) {
  parseIsoDate(start, `${scope}开始日期`);
  parseIsoDate(end, `${scope}结束日期`);
  if (start > end) fail(`${scope}开始日期晚于结束日期`);
  if (payload?.ErrorCode !== 0) fail(`${scope}接口失败 ${payload?.ErrorCode}`);
  const expectedCodes = Object.values(CHOICE_RATE_SERIES_IDS);
  if (!Array.isArray(payload.Codes) || payload.Codes.length !== expectedCodes.length
    || new Set(payload.Codes).size !== expectedCodes.length
    || expectedCodes.some((code) => !payload.Codes.includes(code))) fail(`${scope}指标代码集合不匹配`);
  if (!Array.isArray(payload.Indicators) || payload.Indicators.length !== 1
    || payload.Indicators[0] !== "RESULT") fail(`${scope}返回字段不匹配`);
  assertExactKeys(payload.Data, expectedCodes, `${scope}.Data`);
  if (!Array.isArray(payload.Dates) || payload.Dates.length === 0) fail(`${scope}日期轴为空`);
  const dates = payload.Dates.map((value) => {
    const date = parseIsoDate(typeof value === "string" ? value.replaceAll("/", "-") : value, `${scope}日期`);
    if (date < start || date > end) fail(`${scope}返回区间外日期 ${date}`);
    return date;
  });
  if (new Set(dates).size !== dates.length) fail(`${scope}日期轴重复`);
  const ascending = dates.every((date, index) => index === 0 || date > dates[index - 1]);
  const descending = dates.every((date, index) => index === 0 || date < dates[index - 1]);
  if (!ascending && !descending) fail(`${scope}日期轴乱序`);
  return Object.fromEntries(RATE_SERIES_KEYS.map((key) => {
    const data = payload.Data[CHOICE_RATE_SERIES_IDS[key]];
    if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0])
      || data[0].length !== dates.length) fail(`${scope}.${key}日期与值数量不匹配`);
    const points = data[0].flatMap((value, index) => {
      if (value === null) return []; // Source missing observation, never forward-filled.
      if (typeof value !== "number") fail(`${scope}.${key}.${dates[index]}不是API数值`);
      return [{ date: dates[index], value: parseRateValue(value, `${scope}.${key}.${dates[index]}`) }];
    }).sort((left, right) => left.date.localeCompare(right.date));
    if (points.length < minimumObservations) fail(`${scope}.${key}有效观测不足，疑似返回被截断`);
    if (!points.length || calendarDayDifference(points[0].date, start) > maximumBoundaryLagDays
      || calendarDayDifference(end, points.at(-1).date) > maximumBoundaryLagDays) {
      fail(`${scope}.${key}首末有效观测距查询边界过远`);
    }
    return [key, points];
  }));
}

export function mergeRateChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) fail("利率分段结果不能为空");
  const merged = Object.fromEntries(RATE_SERIES_KEYS.map((key) => [key, new Map()]));

  for (const [chunkIndex, chunk] of chunks.entries()) {
    assertExactKeys(chunk, RATE_SERIES_KEYS, `第${chunkIndex + 1}段利率结果`);
    for (const key of RATE_SERIES_KEYS) {
      if (!Array.isArray(chunk[key])) fail(`第${chunkIndex + 1}段.${key}必须是数组`);
      for (const point of chunk[key]) {
        parseIsoDate(point?.date, `第${chunkIndex + 1}段.${key}日期`);
        const value = parseRateValue(point?.value, `第${chunkIndex + 1}段.${key}.${point?.date}`);
        if (merged[key].has(point.date)) fail(`${key}含有跨分段重复日期 ${point.date}`);
        merged[key].set(point.date, value);
      }
    }
  }

  return Object.fromEntries(RATE_SERIES_KEYS.map((key) => [
    key,
    [...merged[key].entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, value]) => ({ date, value })),
  ]));
}

export function alignUsTreasuryCurve(pointsBySeries) {
  assertExactKeys(pointsBySeries, RATE_SERIES_KEYS, "利率序列集合");
  const treasuryKeys = ["us2y", "us10y", "us30y"];
  const dateSets = Object.fromEntries(treasuryKeys.map((key) => [
    key,
    new Set(pointsBySeries[key].map((point) => point.date)),
  ]));
  const commonDates = new Set(pointsBySeries.us2y
    .map((point) => point.date)
    .filter((date) => dateSets.us10y.has(date) && dateSets.us30y.has(date)));

  const removedDates = new Set();
  let removedObservationCount = 0;
  const removedBySeries = Object.fromEntries(treasuryKeys.map((key) => [key, []]));
  const aligned = { ...pointsBySeries };
  for (const key of treasuryKeys) {
    aligned[key] = pointsBySeries[key].filter((point) => {
      const keep = commonDates.has(point.date);
      if (!keep) {
        removedDates.add(point.date);
        removedObservationCount += 1;
        removedBySeries[key].push(point.date);
      }
      return keep;
    });
    if (aligned[key].length === 0) fail(`${key}按三条美债共同日期对齐后没有有效观测`);
  }

  const orderedRemovedDates = [...removedDates].sort();
  const seriesLabels = {
    us2y: "美国2年期序列",
    us10y: "美国10年期序列",
    us30y: "美国30年期序列",
  };
  const removalDetails = treasuryKeys
    .filter((key) => removedBySeries[key].length > 0)
    .map((key) => (
      `${seriesLabels[key]}在${removedBySeries[key].sort().join("、")}的${removedBySeries[key].length}个美国休市日观测`
    ));
  const warnings = orderedRemovedDates.length === 0
    ? []
    : [
      `美债三期限统一保留共同观测日，已剔除${removalDetails.join("，")}`,
    ];
  return {
    pointsBySeries: aligned,
    removedDates: orderedRemovedDates,
    removedObservationCount,
    warnings,
  };
}

export function buildCn10yCoverageWarnings(
  cn10yPoints,
  { windowStart, windowEnd, minimumObservations = 230 },
) {
  parseIsoDate(windowStart, "中国利率覆盖窗口开始日期");
  parseIsoDate(windowEnd, "中国利率覆盖窗口结束日期");
  if (windowStart > windowEnd) fail("中国利率覆盖窗口开始日期晚于结束日期");
  if (!Number.isInteger(minimumObservations) || minimumObservations <= 0) {
    fail("中国利率年度最低观测数必须是正整数");
  }

  const counts = new Map();
  for (const point of cn10yPoints) {
    const date = parseIsoDate(point?.date, "中国10年期国债到期收益率日期");
    if (date < windowStart || date > windowEnd) fail(`中国10年期国债到期收益率含范围外日期 ${date}`);
    const year = date.slice(0, 4);
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }

  const firstYear = Number(windowStart.slice(0, 4));
  const lastYear = Number(windowEnd.slice(0, 4));
  const lowCoverage = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    if (windowStart > yearStart || windowEnd < yearEnd) continue;
    const count = counts.get(String(year)) ?? 0;
    if (count < minimumObservations) lowCoverage.push({ year, count });
  }

  if (lowCoverage.length === 0) return [];
  const details = lowCoverage.map(({ year, count }) => `${year}年${count}个`).join("、");
  return [
    `中国10年期国债收益率在${details}有效观测，利差只使用同日有效值且不做前向填充`,
  ];
}

function latestCommonDate(pointGroups, scope) {
  if (!Array.isArray(pointGroups) || pointGroups.length < 2) fail(`${scope}需要至少两组序列`);
  const dateSets = pointGroups.slice(1).map((points) => new Set(points.map((point) => point.date)));
  const date = [...pointGroups[0]].reverse().find((point) => (
    dateSets.every((dates) => dates.has(point.date))
  ))?.date;
  if (!date) fail(`${scope}没有共同观测日`);
  return date;
}

export function buildSpreadPoints(us10yPoints, cn10yPoints) {
  const cnByDate = new Map(cn10yPoints.map((point) => [point.date, point.value]));
  return us10yPoints.flatMap((point) => {
    if (!cnByDate.has(point.date)) return [];
    const cn10y = cnByDate.get(point.date);
    return [{
      date: point.date,
      us10y: point.value,
      cn10y,
      value: round((point.value - cn10y) * 100),
    }];
  });
}

export function buildRateSnapshot({ requestedDate, fetchedAt, pointsBySeries, warnings = [] }) {
  parseIsoDate(requestedDate, "输入日期");
  parseIsoTimestamp(fetchedAt, "抓取时间");
  assertExactKeys(pointsBySeries, RATE_SERIES_KEYS, "利率序列集合");

  const series = Object.fromEntries(RATE_SERIES_KEYS.map((key) => [key, {
    name: RATE_SERIES_CONFIG[key].name,
    source: RATE_SERIES_CONFIG[key].source,
    unit: RATE_SERIES_CONFIG[key].unit,
    points: pointsBySeries[key],
  }]));
  const windowStart = RATE_SERIES_KEYS
    .map((key) => pointsBySeries[key][0]?.date)
    .filter(Boolean)
    .sort()[0];
  if (!windowStart) fail("利率序列没有有效起点");

  const curveAsOf = latestCommonDate(
    [series.us2y.points, series.us10y.points, series.us30y.points],
    "美债期限曲线",
  );
  const spreadPoints = buildSpreadPoints(series.us10y.points, series.cn10y.points);
  if (spreadPoints.length === 0) fail("中美10年期收益率没有共同观测日");
  const spreadAsOf = spreadPoints.at(-1).date;

  const snapshot = {
    schemaVersion: RATE_SCHEMA_VERSION,
    requestedDate,
    fetchedAt,
    windowStart,
    curveAsOf,
    spreadAsOf,
    source: RATE_SOURCE,
    series,
    spread: {
      ...RATE_SPREAD_META,
      points: spreadPoints,
    },
    alignmentMethod: RATE_ALIGNMENT_METHOD,
    warnings: [...warnings],
  };
  validateRateSnapshot(snapshot, { expectedRequestedDate: requestedDate });
  return snapshot;
}

function validatePointSeries(points, { scope, windowStart, requestedDate }) {
  if (!Array.isArray(points) || points.length === 0) fail(`${scope}.points不能为空`);
  let previousDate = null;
  for (const [index, point] of points.entries()) {
    assertExactKeys(point, ["date", "value"], `${scope}.points[${index}]`);
    const date = parseIsoDate(point.date, `${scope}.points[${index}].date`);
    const value = parseRateValue(point.value, `${scope}.points[${index}].value`);
    if (date < windowStart || date > requestedDate) fail(`${scope}含有范围外日期 ${date}`);
    if (previousDate !== null && date <= previousDate) fail(`${scope}日期没有严格递增 ${date}`);
    if (value !== point.value) fail(`${scope}.${date}必须保存为数字`);
    previousDate = date;
  }
}

function validateSource(source) {
  // Old saved snapshots remain readable for rollback; acquisition never calls MCP.
  const expected = source?.provider === LEGACY_RATE_SOURCE.provider ? LEGACY_RATE_SOURCE : RATE_SOURCE;
  assertExactKeys(source, Object.keys(expected), "source");
  for (const field of ["provider", "tool", "endpoint"]) {
    if (source[field] !== expected[field]) fail(`source.${field}不匹配`);
  }
  assertExactKeys(source.series, RATE_SERIES_KEYS, "source.series");
  for (const key of RATE_SERIES_KEYS) {
    if (source.series[key] !== expected.series[key]) fail(`source.series.${key}不匹配`);
  }
  if (expected === RATE_SOURCE) {
    assertExactKeys(source.indicators, RATE_SERIES_KEYS, "source.indicators");
    for (const key of RATE_SERIES_KEYS) {
      if (source.indicators[key] !== CHOICE_RATE_SERIES_IDS[key]) fail(`source.indicators.${key}不匹配`);
    }
  }
}

export function validateRateSnapshot(snapshot, options = {}) {
  const topLevelFields = [
    "schemaVersion", "requestedDate", "fetchedAt", "windowStart", "curveAsOf",
    "spreadAsOf", "source", "series", "spread", "alignmentMethod", "warnings",
  ];
  assertExactKeys(snapshot, topLevelFields, "利率快照");
  if (snapshot.schemaVersion !== RATE_SCHEMA_VERSION) fail(`不支持的利率快照版本 ${snapshot.schemaVersion}`);

  const requestedDate = parseIsoDate(snapshot.requestedDate, "requestedDate");
  if (options.expectedRequestedDate && requestedDate !== options.expectedRequestedDate) {
    fail(`快照输入日期不匹配 ${requestedDate}`);
  }
  parseIsoTimestamp(snapshot.fetchedAt, "fetchedAt");
  const windowStart = parseIsoDate(snapshot.windowStart, "windowStart");
  const curveAsOf = parseIsoDate(snapshot.curveAsOf, "curveAsOf");
  const spreadAsOf = parseIsoDate(snapshot.spreadAsOf, "spreadAsOf");
  if (windowStart > requestedDate) fail("windowStart晚于requestedDate");
  if (curveAsOf > requestedDate || spreadAsOf > requestedDate) fail("截止日期晚于requestedDate");

  validateSource(snapshot.source);
  assertExactKeys(snapshot.series, RATE_SERIES_KEYS, "series");
  for (const key of RATE_SERIES_KEYS) {
    const series = snapshot.series[key];
    assertExactKeys(series, ["name", "source", "unit", "points"], `series.${key}`);
    const config = RATE_SERIES_CONFIG[key];
    if (series.name !== config.name || series.source !== config.source || series.unit !== config.unit) {
      fail(`series.${key}元数据不匹配`);
    }
    validatePointSeries(series.points, {
      scope: `series.${key}`,
      windowStart,
      requestedDate,
    });
  }

  const treasuryDates = snapshot.series.us2y.points.map((point) => point.date);
  for (const key of ["us10y", "us30y"]) {
    const dates = snapshot.series[key].points.map((point) => point.date);
    if (dates.length !== treasuryDates.length
      || dates.some((date, index) => date !== treasuryDates[index])) {
      fail(`series.${key}日期集合与series.us2y不一致`);
    }
  }

  const actualWindowStart = RATE_SERIES_KEYS
    .map((key) => snapshot.series[key].points[0].date)
    .sort()[0];
  if (windowStart !== actualWindowStart) fail(`windowStart应为 ${actualWindowStart}`);

  const expectedCurveAsOf = latestCommonDate([
    snapshot.series.us2y.points,
    snapshot.series.us10y.points,
    snapshot.series.us30y.points,
  ], "美债期限曲线");
  if (curveAsOf !== expectedCurveAsOf) fail(`curveAsOf应为 ${expectedCurveAsOf}`);

  assertExactKeys(snapshot.spread, ["name", "formula", "unit", "points"], "spread");
  for (const field of ["name", "formula", "unit"]) {
    if (snapshot.spread[field] !== RATE_SPREAD_META[field]) fail(`spread.${field}不匹配`);
  }
  if (!Array.isArray(snapshot.spread.points) || snapshot.spread.points.length === 0) {
    fail("spread.points不能为空");
  }

  const expectedSpread = buildSpreadPoints(
    snapshot.series.us10y.points,
    snapshot.series.cn10y.points,
  );
  if (snapshot.spread.points.length !== expectedSpread.length) {
    fail(`spread.points数量应为 ${expectedSpread.length}`);
  }
  for (const [index, point] of snapshot.spread.points.entries()) {
    assertExactKeys(point, ["date", "us10y", "cn10y", "value"], `spread.points[${index}]`);
    const expected = expectedSpread[index];
    parseIsoDate(point.date, `spread.points[${index}].date`);
    for (const field of ["date", "us10y", "cn10y", "value"]) {
      if (point[field] !== expected[field]) {
        fail(`spread.points[${index}].${field}与同日原始收益率不一致`);
      }
    }
  }
  if (spreadAsOf !== expectedSpread.at(-1).date) fail(`spreadAsOf应为 ${expectedSpread.at(-1).date}`);

  if (snapshot.alignmentMethod !== RATE_ALIGNMENT_METHOD) fail("alignmentMethod不匹配");
  if (!Array.isArray(snapshot.warnings)) fail("warnings必须是数组");
  const warningSet = new Set();
  for (const [index, warning] of snapshot.warnings.entries()) {
    if (typeof warning !== "string" || warning.trim() === "") fail(`warnings[${index}]不是非空字符串`);
    if (warningSet.has(warning)) fail(`warnings含有重复内容 ${warning}`);
    warningSet.add(warning);
  }

  return snapshot;
}
