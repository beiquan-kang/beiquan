import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePython } from '../../lib/runtime.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const BRENT_SOURCE_SERIES_ID = 'EMM01588169';
export const BRENT_SOURCE_INDICATOR = '期货收盘价(连续):ICE布油(美元/桶)';
export const BRENT_SOURCE_URL = `https://choicew2z.eastmoney.com/dataDisplay/macroEDB/#/index?macroids=${BRENT_SOURCE_SERIES_ID}`;

// B.IPE identifies the requested product in Wind. Data remain explicitly identified
// as Choice's continuous series because vendor roll and close conventions can differ.
export const BRENT_MAPPING = {
  displaySeriesId: 'B.IPE',
  displayCodeProvider: 'Wind',
  sourceSeriesId: BRENT_SOURCE_SERIES_ID,
  mappingStatus: 'same-product-provider-continuous',
  mappingNote: 'B.IPE 为 Wind 品种识别代码，实际价格采用 Choice 的 ICE 布油连续期货收盘价；不同供应商的连续换月与收盘口径可能存在差异。',
  contractSpecificationUrl: 'https://www.ice.com/products/219/Brent-Crude-Futures',
};

function isoDate(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label}必须使用 YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}无效 ${value}`);
  }
  return value;
}

function daysBetween(later, earlier) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

function addYears(value, years) {
  const date = new Date(`${value}T00:00:00Z`);
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function previousDate(value) {
  return new Date(Date.parse(`${value}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function daysAgo(value, days) {
  return new Date(Date.parse(`${value}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

function validateHistory(history, label) {
  if (!Array.isArray(history)) throw new Error(`${label}必须是数组`);
  const seen = new Set();
  return history.map((point) => {
    const date = isoDate(point?.date, `${label}日期`);
    if (seen.has(date) || typeof point?.value !== 'number'
      || !Number.isFinite(point.value) || point.value <= 0 || point.value > 1_000) {
      throw new Error(`${label}存在重复日期或无效价格`);
    }
    seen.add(date);
    return { date, value: point.value };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export function brentHistoryChunks(requestedDate) {
  isoDate(requestedDate, '输入日期');
  const start = addYears(requestedDate, -10);
  return Array.from({ length: 10 }, (_, index) => ({
    start: addYears(start, index),
    end: index === 9 ? requestedDate : previousDate(addYears(start, index + 1)),
  }));
}

export function buildBrentFetchPlan(requestedDate, previousHistory = [], now = new Date()) {
  isoDate(requestedDate, '输入日期');
  // ICE's trading session is still open during the current Beijing calendar day.
  // Daily-close EDB observations for that day must not enter the published chart.
  const beijingToday = new Date(now.valueOf() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const lastClosedDate = previousDate(beijingToday);
  const queryEnd = requestedDate < lastClosedDate ? requestedDate : lastClosedDate;
  const queryStart = addYears(queryEnd, -10);
  const retained = validateHistory(previousHistory, '布伦特已有历史')
    .filter((point) => point.date >= queryStart && point.date <= queryEnd);
  const canIncrement = retained.length >= 1_800
    && daysBetween(retained[0].date, queryStart) <= 14
    && daysBetween(queryEnd, retained.at(-1).date) <= 90;
  const refreshStart = canIncrement ? daysAgo(retained.at(-1).date, 30) : queryStart;
  return {
    queryStart,
    queryEnd,
    refreshStart,
    fetchMode: canIncrement ? 'incremental' : 'full',
    ranges: canIncrement
      ? [{ start: refreshStart, end: queryEnd, minimumObservations: 10 }]
      : brentHistoryChunks(queryEnd),
  };
}

export function mergeBrentHistory(previousHistory, freshHistory, { queryStart, queryEnd, refreshStart }) {
  isoDate(queryStart);
  isoDate(queryEnd);
  isoDate(refreshStart);
  if (queryStart > refreshStart || refreshStart > queryEnd) throw new Error('布伦特合并窗口无效');
  const retained = validateHistory(previousHistory, '布伦特已有历史')
    .filter((point) => point.date >= queryStart && point.date < refreshStart);
  const fresh = validateHistory(freshHistory, '布伦特新取得历史');
  if (fresh.some((point) => point.date < refreshStart || point.date > queryEnd)) {
    throw new Error('布伦特新取得历史超出刷新窗口');
  }
  // Replace the complete refreshed interval, including deleted or revised source
  // observations. Keeping cached dates with a now-missing close would fill gaps.
  return [...retained, ...fresh];
}

export function parseBrentPayload(payload, { start, end, minimumObservations = 180 }) {
  isoDate(start, '查询起始日期');
  isoDate(end, '查询结束日期');
  if (start > end) throw new Error('布伦特查询日期顺序错误');
  const request = payload?.request;
  const raw = payload?.result;
  if (request?.fn !== 'edb' || !Array.isArray(request.args) || request.args.length !== 2
    || request.args[0] !== BRENT_SOURCE_SERIES_ID || typeof request.args[1] !== 'string') {
    throw new Error(`ICE 布伦特请求未确认源端指标 ${BRENT_SOURCE_SERIES_ID}`);
  }
  const entries = request.args[1].split(',').map((part) => part.split('='));
  if (entries.some((entry) => entry.length !== 2 || !entry[0] || !entry[1])
    || new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error('ICE 布伦特 API 参数重复或无效');
  }
  const options = Object.fromEntries(entries);
  if (options.StartDate !== start || options.EndDate !== end || options.IsLatest !== '0'
    || options.FixDate !== '0' || options.Ispandas !== '0') {
    throw new Error('ICE 布伦特 API 查询窗口或原始观察日参数不符');
  }
  if (raw?.ErrorCode !== 0 || !Array.isArray(raw.Codes) || raw.Codes.length !== 1
    || raw.Codes[0] !== BRENT_SOURCE_SERIES_ID || !Array.isArray(raw.Indicators)
    || raw.Indicators.length !== 1 || raw.Indicators[0] !== 'RESULT') {
    throw new Error(`ICE 布伦特 API 错误或源端指标不符 ${BRENT_SOURCE_SERIES_ID}`);
  }
  if (!Array.isArray(raw.Dates) || !raw.Data || typeof raw.Data !== 'object'
    || Object.keys(raw.Data).length !== 1 || !Array.isArray(raw.Data[BRENT_SOURCE_SERIES_ID])
    || raw.Data[BRENT_SOURCE_SERIES_ID].length !== 1
    || !Array.isArray(raw.Data[BRENT_SOURCE_SERIES_ID][0])
    || raw.Data[BRENT_SOURCE_SERIES_ID][0].length !== raw.Dates.length) {
    throw new Error('ICE 布伦特 API 日期与价格轴不一致');
  }
  // EMM01588169 is the same close series used before the transport migration.
  // The SDK identifies EDB values as RESULT; it does not return a price-field
  // name. Identity comes from the exact requested and returned EDB series ID.
  const row = raw.Data[BRENT_SOURCE_SERIES_ID][0];
  const seen = new Set();
  const history = [];
  for (let index = 0; index < raw.Dates.length; index += 1) {
    const sourceDate = raw.Dates[index];
    if (typeof sourceDate !== 'string' || !/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(sourceDate)) {
      throw new Error('ICE 布伦特 API 原始观察日期无效');
    }
    const date = isoDate(sourceDate.replaceAll('/', '-'), '布伦特观测日期');
    if (date < start || date > end || seen.has(date)) {
      throw new Error(`ICE 布伦特存在区间外或重复日期 ${date}`);
    }
    seen.add(date);
    const price = row[index];
    if (price === null) continue;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1_000) {
      throw new Error(`ICE 布伦特 ${date} 收盘价无效`);
    }
    history.push({ date, value: price });
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length < minimumObservations) {
    throw new Error(`ICE 布伦特 ${start} 至 ${end} 仅有 ${history.length} 个观测，疑似截断`);
  }
  if (!history.length || daysBetween(history[0].date, start) > 14 || daysBetween(end, history.at(-1).date) > 14) {
    throw new Error(`ICE 布伦特 ${start} 至 ${end} 历史边界缺失`);
  }
  return history;
}

export async function fetchChoiceBrentRanges(ranges, options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const environment = options.environment ?? process.env;
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const directory = path.join(root, 'data/us-liquidity/raw/choice-brent', `${timestamp}-${process.pid}`);
  await fs.mkdir(directory, { recursive: true });
  const requestPath = path.join(directory, 'request.json');
  const responsePath = path.join(directory, 'response.json');
  await fs.writeFile(requestPath, JSON.stringify({ seriesId: BRENT_SOURCE_SERIES_ID, ranges }, null, 2), 'utf8');
  try {
    await execFileAsync(resolvePython(environment), [
      '-X', 'utf8', path.join(root, 'scripts/us-liquidity-data/fetch_brent_choice.py'), requestPath, responsePath,
    ], { cwd: root, env: environment, windowsHide: true, encoding: 'utf8',
      timeout: (ranges.length * 3 * 125 + 30) * 1_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(`Choice 布伦特 API 获取失败，原始记录 ${directory}`);
  }
  const payload = JSON.parse(await fs.readFile(responsePath, 'utf8'));
  return { ...payload, evidenceDirectory: directory };
}

export async function fetchBrentHistory(requestedDate, options = {}) {
  const previousHistory = options.previousHistory ?? [];
  const plan = buildBrentFetchPlan(requestedDate, previousHistory, options.now ?? new Date());
  const chunks = plan.ranges;
  const payload = await (options.fetchChoiceRanges ?? fetchChoiceBrentRanges)(chunks, options);
  if (payload.source !== 'Choice.edb' || payload.seriesId !== BRENT_SOURCE_SERIES_ID
    || !Array.isArray(payload.results) || payload.results.length !== chunks.length) {
    throw new Error('Choice 布伦特 API 返回分片数量或来源不符');
  }
  const histories = payload.results.map((result, index) => parseBrentPayload(result, chunks[index]));
  const history = mergeBrentHistory(previousHistory, histories.flat(), plan);
  return {
    history,
    sourceName: 'Choice 量化 API，直接调用 edb',
    sourceUrl: BRENT_SOURCE_URL,
    seriesId: 'B.IPE',
    ...BRENT_MAPPING,
    sourceIndicator: BRENT_SOURCE_INDICATOR,
    unit: '美元/桶',
    frequency: 'daily',
    priceField: 'close',
    requestedDate,
    queryStart: plan.queryStart,
    queryEnd: plan.queryEnd,
    refreshStart: plan.refreshStart,
    fetchMode: plan.fetchMode,
    dateCutoff: '最多取北京时间昨日的源端日收盘价',
    fetchedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    sourceFunction: 'Choice.edb',
    evidenceDirectory: payload.evidenceDirectory ?? null,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const requestedDate = process.argv[2];
  const result = await fetchBrentHistory(requestedDate);
  const output = path.join(repoRoot, 'outputs/us-liquidity/brent-source-probe.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output, count: result.history.length, first: result.history[0], last: result.history.at(-1) }));
}
