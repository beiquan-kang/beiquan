#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildRefreshAudit } = require('./lib/refresh-audit.cjs');
const { CALENDAR_URL, noteLinks, parseNote, reconcileRange } = require('./lib/policy-target.cjs');
let transport;
async function publicRead(url, options) {
  transport ??= import('../lib/http.mjs');
  return (await transport).publicFetch(url, options);
}

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(REPO_ROOT, 'data', 'us-liquidity');
const CATALOG_PATH = path.join(DATA_DIR, 'indicator-catalog.json');
const CURRENT_PATH = path.join(DATA_DIR, 'current.json');
const CANDIDATE_PATH = path.resolve(
  process.env.US_LIQUIDITY_CANDIDATE_PATH || path.join(DATA_DIR, 'candidate.json')
);

if (CANDIDATE_PATH.toLowerCase() === CURRENT_PATH.toLowerCase()) {
  throw new Error('候选文件不能直接指向正式数据文件');
}

const FRED_START_DATE = '1900-01-01';
const FISCAL_HISTORY_YEARS = 10;
const FISCAL_PAGE_SIZE = 10_000;
const FISCAL_MAX_PAGES = 60;
const REQUEST_RETRIES = 2;
const USER_AGENT = 'DollarLiquidityDashboard/1.0 (+local research dashboard)';

const FRED_DIRECT_SERIES = {
  SP500: 'sp500',
  DTWEXBGS: 'broad_dollar',
  DFII10: 'tips_10y_real_yield',
  BAMLH0A0HYM2: 'hy_oas',
  VIXCLS: 'vix',
  SOFR: 'sofr',
  RRPONTSYOFFR: 'on_rrp_rate',
  TGCRRATE: 'tgcr',
  SOFRVOL: 'sofr_volume',
  DGS2: 'treasury_yield_2y',
  DGS5: 'treasury_yield_5y',
  DGS10: 'treasury_yield_10y',
  DEXUSEU: 'eurusd_spot',
  DEXJPUS: 'usdjpy_spot',
  DEXCHUS: 'usdcny_spot',
  WRESBAL: 'reserve_balances',
  DPSSCBW027SBOG: 'small_bank_deposits',
  WLCFLPCL: 'discount_window_primary',
  SWPT: 'swap_line_balance',
  H41RESPPALGTRFNWW: 'fima_repo_balance',
  RPONTTLD: 'srf_repo_accepted',
  FGNETWQ027S: 'federal_government_net_worth',
  EFFR: 'effr',
  IORB: 'iorb'
};

const FRED_DEPENDENCIES = [
  'RIFSPPNA2P2D30NB',
  'RIFSPPNAAD30NB',
  'CASSCBW027SBOG',
  'TLASCBW027SBOG',
  'DFEDTARL',
  'DFEDTARU'
];

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取JSON ${filePath}，${error.message}`);
  }
}

function parseArgs(argv) {
  if (argv.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(argv[0])) {
    throw new Error('用法 node fetch-current.cjs YYYY-MM-DD');
  }
  const requestedDate = argv[0];
  const parsed = new Date(`${requestedDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== requestedDate) {
    throw new Error(`输入日期无效 ${requestedDate}`);
  }
  return {
    requestedDate,
    referenceDate: parsed
  };
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateYearsAgo(requestedDate, years, extraDays = 0) {
  const date = new Date(`${requestedDate}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  date.setUTCDate(date.getUTCDate() - extraDays);
  return toIsoDate(date);
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replaceAll(',', '');
  if (!normalized || normalized === '.' || /^n\.?a\.?$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text).replace(/^\uFEFF/, '');

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((item) => item !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((item) => item !== '')) rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => {
    const result = {};
    headers.forEach((header, index) => {
      result[header] = values[index] ?? '';
    });
    return result;
  });
}

async function fetchWithRetry(url, responseType = 'text') {
  let lastError;
  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await publicRead(url, {
        headers: {
          Accept: responseType === 'json' ? 'application/json' : 'text/csv,text/plain;q=0.9,*/*;q=0.8',
          'User-Agent': USER_AGENT
        },
        redirect: 'follow'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const body = await response.text();
      const evidence = process.env.USD_LIQUIDITY_RAW_DIR;
      if (evidence) {
        fs.mkdirSync(evidence, { recursive: true });
        const hash = require('node:crypto').createHash('sha256').update(String(url)).digest('hex').slice(0, 20);
        fs.writeFileSync(path.join(evidence, `${hash}.json`), JSON.stringify({
          url: String(url), retrievedAt: new Date().toISOString(), status: response.status, body,
        }), 'utf8');
      }
      return responseType === 'json' ? JSON.parse(body) : body;
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      }
    }
  }
  throw new Error(lastError?.message || '未知网络错误');
}

async function fetchFiscalDataPages(baseUrl, query) {
  const rows = [];
  for (let pageNumber = 1; pageNumber <= FISCAL_MAX_PAGES; pageNumber += 1) {
    const params = new URLSearchParams(query);
    params.set('page[number]', String(pageNumber));
    params.set('page[size]', String(FISCAL_PAGE_SIZE));
    const payload = await fetchWithRetry(`${baseUrl}?${params.toString()}`, 'json');
    if (!Array.isArray(payload?.data)) throw new Error('财政部API返回结构无效');
    rows.push(...payload.data);

    const totalPages = parseNumber(
      payload.meta?.['total-pages']
      ?? payload.meta?.total_pages
      ?? payload.meta?.totalPages
    );
    if ((totalPages !== null && pageNumber >= totalPages) || payload.data.length < FISCAL_PAGE_SIZE) {
      return rows;
    }
  }
  throw new Error(`财政部API分页超过安全上限 ${FISCAL_MAX_PAGES}`);
}

async function fetchFredSeries(seriesId, requestedDate) {
  const params = new URLSearchParams({
    id: seriesId,
    cosd: FRED_START_DATE,
    coed: requestedDate
  });
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?${params.toString()}`;
  const rows = parseCsv(await fetchWithRetry(url));
  if (!rows.length) throw new Error('返回CSV为空');

  const headers = Object.keys(rows[0]);
  const dateKey = headers.find((key) => /^(observation_)?date$/i.test(key));
  const valueKey = headers.find((key) => key.toUpperCase() === seriesId.toUpperCase())
    || headers.find((key) => key !== dateKey);
  if (!dateKey || !valueKey) throw new Error(`CSV字段缺失，现有字段 ${headers.join(', ')}`);

  const history = rows
    .map((row) => ({ date: row[dateKey], value: parseNumber(row[valueKey]) }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.value !== null);
  if (!history.length) throw new Error('序列没有有效观察值');
  return history;
}

function normalizeHistory(history, valueScale = 1) {
  const byDate = new Map();
  for (const item of history || []) {
    const value = parseNumber(item.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) || value === null) continue;
    byDate.set(item.date, round(value * valueScale));
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({ date, value }));
}

function fredQuarterStartToQuarterEnd(history) {
  return history.map((item) => {
    const match = /^(\d{4})-(01|04|07|10)-01$/.exec(item.date || '');
    if (!match) return item;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return {
      ...item,
      date: toIsoDate(new Date(Date.UTC(year, month + 2, 0)))
    };
  });
}

function alignAndCalculate(leftHistory, rightHistory, calculator) {
  const rightByDate = new Map(rightHistory.map((item) => [item.date, item.value]));
  return leftHistory
    .filter((item) => rightByDate.has(item.date))
    .map((item) => ({
      date: item.date,
      value: calculator(item.value, rightByDate.get(item.date))
    }))
    .filter((item) => Number.isFinite(item.value));
}

function rollingSum(history, windowLength) {
  return history.map((item, index) => {
    const start = Math.max(0, index - windowLength + 1);
    const window = history.slice(start, index + 1);
    if (window.length < windowLength) return null;
    return {
      date: item.date,
      value: window.reduce((sum, current) => sum + current.value, 0)
    };
  }).filter(Boolean);
}

function daysOld(dateText, generatedAt) {
  if (!dateText) return null;
  const observation = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(observation.getTime())) return null;
  return Math.max(0, Math.floor((generatedAt.getTime() - observation.getTime()) / 86_400_000));
}

function flattenPrevious(previous, catalog) {
  const result = new Map();
  for (const module of previous?.modules || []) {
    for (const indicator of module.indicators || []) {
      if (!indicator?.id || result.has(indicator.id) || !catalog.indicators[indicator.id]) continue;
      let migrated = indicator;
      if (indicator.unit === '十亿美元' && catalog.indicators[indicator.id].unit === '亿美元') {
        migrated = {
          ...indicator,
          value: Number.isFinite(indicator.value) ? round(indicator.value * 10) : indicator.value,
          change: Number.isFinite(indicator.change) ? round(indicator.change * 10) : indicator.change,
          unit: '亿美元',
          changeUnit: indicator.changeUnit === '十亿美元' ? '亿美元' : indicator.changeUnit,
          history: (indicator.history || []).map((item) => ({
            ...item,
            value: Number.isFinite(item.value) ? round(item.value * 10) : item.value
          }))
        };
      }
      result.set(indicator.id, migrated);
    }
  }
  return result;
}

function makeIndicator(config, previousIndicator, generatedAt) {
  const intentionallyMissing = config.availability === 'licensed_required';
  const canPreserve = !intentionallyMissing && previousIndicator?.value !== null
    && previousIndicator?.value !== undefined;
  const history = canPreserve && Array.isArray(previousIndicator.history)
    ? previousIndicator.history
    : [];
  const updatedAt = canPreserve ? previousIndicator.updatedAt || previousIndicator.observationDate || null : null;

  return {
    id: config.id,
    name: config.name,
    shortName: config.shortName || null,
    value: canPreserve ? previousIndicator.value : null,
    unit: config.unit,
    displayDigits: config.displayDigits ?? null,
    change: canPreserve ? previousIndicator.change ?? null : null,
    changeLabel: config.changeLabel || null,
    changeUnit: config.changeUnit || config.unit,
    status: canPreserve ? 'stale' : 'missing',
    direction: config.direction,
    definition: config.definition,
    formula: config.formula,
    sourceName: config.sourceName,
    sourceUrl: config.sourceUrl,
    seriesId: config.seriesId,
    ...(config.sourceSeriesId ? { sourceSeriesId: config.sourceSeriesId } : {}),
    frequency: config.frequency,
    updatedAt,
    observationDate: updatedAt,
    dataAgeDays: daysOld(updatedAt, generatedAt),
    availability: config.availability,
    limitation: config.limitations,
    testFlag: previousIndicator?.testFlag || null,
    retainedPreviousValue: canPreserve,
    error: intentionallyMissing ? '需要商业授权数据，当前版本保留为空值' : null,
    history,
    historyStart: history[0]?.date || null,
    historyEnd: history.at(-1)?.date || null,
    historyCount: history.length,
    ...(canPreserve && previousIndicator.rangeHistory ? {
      rangeHistory: previousIndicator.rangeHistory,
      rangeLow: previousIndicator.rangeLow,
      rangeHigh: previousIndicator.rangeHigh,
      policyDecision: previousIndicator.policyDecision,
    } : {})
  };
}

function setIndicatorHistory(indicators, catalog, indicatorId, rawHistory, generatedAt, options = {}) {
  const config = catalog.indicators[indicatorId];
  const valueScale = options.valueScale ?? config.valueScale ?? 1;
  const history = normalizeHistory(rawHistory, valueScale);
  if (!history.length) throw new Error(`${indicatorId}没有有效观察值`);

  const preferredChange = config.preferredChange || 1;
  const latest = history.at(-1);
  const previousIndex = history.length - 1 - preferredChange;
  const rawChange = previousIndex >= 0 ? latest.value - history[previousIndex].value : null;
  const changeScale = config.changeScale || 1;
  const age = daysOld(latest.date, generatedAt);
  const staleAfterDays = config.staleAfterDays ?? 14;

  indicators[indicatorId] = {
    ...indicators[indicatorId],
    value: latest.value,
    change: rawChange === null ? null : round(rawChange * changeScale),
    changeLabel: config.changeLabel || null,
    changeUnit: config.changeUnit || config.unit,
    status: age !== null && age > staleAfterDays ? 'stale' : 'ok',
    updatedAt: latest.date,
    observationDate: latest.date,
    dataAgeDays: age,
    testFlag: options.testFlag || null,
    retainedPreviousValue: false,
    error: null,
    history,
    historyStart: history[0].date,
    historyEnd: history.at(-1).date,
    historyCount: history.length
  };
}

function markIndicatorFailure(indicators, indicatorIds, message) {
  for (const id of indicatorIds) {
    const indicator = indicators[id];
    if (!indicator || indicator.availability === 'licensed_required') continue;
    indicator.status = indicator.value === null ? 'missing' : 'stale';
    indicator.error = message;
  }
}

function moduleStatus(indicators) {
  if (!indicators.length || indicators.every((item) => item.status === 'missing')) return 'missing';
  if (indicators.some((item) => item.status === 'stale')) return 'stale';
  if (indicators.some((item) => item.status === 'missing')) return 'partial';
  return 'ok';
}

function latestObservationDate(indicators) {
  return indicators
    .map((item) => item.observationDate)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  const backupPath = `${filePath}.bak-${process.pid}`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temporaryPath, serialized, 'utf8');
  JSON.parse(fs.readFileSync(temporaryPath, 'utf8'));

  let backupCreated = false;
  try {
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, backupPath);
      backupCreated = true;
    }
    fs.renameSync(temporaryPath, filePath);
    if (backupCreated) fs.unlinkSync(backupPath);
  } catch (error) {
    if (!fs.existsSync(filePath) && backupCreated && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, filePath);
    }
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

async function fetchOfr(indicators, catalog, referenceDate, requestedDate, state) {
  const url = catalog.indicators.ofr_fsi.sourceUrl;
  try {
    const rows = parseCsv(await fetchWithRetry(url));
    if (!rows.length) throw new Error('返回CSV为空');
    const headers = Object.keys(rows[0]);
    const dateKey = headers.find((key) => /^date$/i.test(key.trim()));
    const valueKey = headers.find((key) => key.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'ofrfsi');
    if (!dateKey || !valueKey) throw new Error(`CSV字段缺失，现有字段 ${headers.join(', ')}`);
    const history = rows
      .map((row) => ({ date: row[dateKey], value: row[valueKey] }))
      .filter((item) => item.date <= requestedDate);
    setIndicatorHistory(indicators, catalog, 'ofr_fsi', history, referenceDate);
    state.sourceSuccessCount += 1;
  } catch (error) {
    const message = `OFR FSI抓取失败，${error.message}`;
    state.errors.push({ source: 'OFR', indicatorIds: ['ofr_fsi'], message });
    state.sourceFailureCount += 1;
    markIndicatorFailure(indicators, ['ofr_fsi'], message);
  }
}

async function fetchFred(indicators, catalog, referenceDate, requestedDate, state) {
  const requiredSeries = [...Object.keys(FRED_DIRECT_SERIES), ...FRED_DEPENDENCIES];
  const results = new Map();

  await Promise.all(requiredSeries.map(async (seriesId) => {
    try {
      results.set(seriesId, await fetchFredSeries(seriesId, requestedDate));
      state.sourceSuccessCount += 1;
    } catch (error) {
      state.sourceFailureCount += 1;
      state.errors.push({
        source: 'FRED',
        seriesId,
        indicatorIds: FRED_DIRECT_SERIES[seriesId] ? [FRED_DIRECT_SERIES[seriesId]] : [],
        message: `${seriesId}抓取失败，${error.message}`
      });
    }
  }));

  for (const [seriesId, indicatorId] of Object.entries(FRED_DIRECT_SERIES)) {
    const history = results.get(seriesId);
    if (history) {
      const normalizedDates = indicatorId === 'federal_government_net_worth'
        ? fredQuarterStartToQuarterEnd(history)
        : history;
      setIndicatorHistory(indicators, catalog, indicatorId, normalizedDates, referenceDate);
    } else {
      markIndicatorFailure(indicators, [indicatorId], `${seriesId}本次刷新失败，已保留已有快照`);
    }
  }

  const sofr = results.get('SOFR');
  const onRrp = results.get('RRPONTSYOFFR');
  if (sofr && onRrp) {
    const history = alignAndCalculate(sofr, onRrp, (left, right) => 100 * (left - right));
    setIndicatorHistory(indicators, catalog, 'sofr_onrrp_spread', history, referenceDate, { valueScale: 1 });
  } else {
    const message = 'SOFR与ON RRP报价利率未能同时取得，主利差未刷新';
    state.errors.push({
      source: 'FRED derived',
      indicatorIds: ['sofr_onrrp_spread'],
      message
    });
    markIndicatorFailure(indicators, ['sofr_onrrp_spread'], message);
  }

  const lowGradeCp = results.get('RIFSPPNA2P2D30NB');
  const highGradeCp = results.get('RIFSPPNAAD30NB');
  if (lowGradeCp && highGradeCp) {
    const history = alignAndCalculate(lowGradeCp, highGradeCp, (left, right) => 100 * (left - right));
    setIndicatorHistory(indicators, catalog, 'cp_credit_spread', history, referenceDate, { valueScale: 1 });
  } else {
    const message = '两条商业票据利率未能同时取得，信用评级利差未刷新';
    state.errors.push({ source: 'FRED derived', indicatorIds: ['cp_credit_spread'], message });
    markIndicatorFailure(indicators, ['cp_credit_spread'], message);
  }

  const cashAssets = results.get('CASSCBW027SBOG');
  const totalAssets = results.get('TLASCBW027SBOG');
  if (cashAssets && totalAssets) {
    const history = alignAndCalculate(cashAssets, totalAssets, (cash, total) => (
      total === 0 ? Number.NaN : 100 * cash / total
    ));
    setIndicatorHistory(indicators, catalog, 'small_bank_cash_ratio', history, referenceDate, { valueScale: 1 });
  } else {
    const message = '小银行现金资产与总资产未能同时取得，现金资产占比未刷新';
    state.errors.push({ source: 'FRED derived', indicatorIds: ['small_bank_cash_ratio'], message });
    markIndicatorFailure(indicators, ['small_bank_cash_ratio'], message);
  }

  const targetLower = results.get('DFEDTARL');
  const targetUpper = results.get('DFEDTARU');
  if (targetLower && targetUpper) {
    const upperByDate = new Map(targetUpper.map((item) => [item.date, item.value]));
    let rangeHistory = targetLower
      .filter((item) => upperByDate.has(item.date))
      .map((item) => ({
        date: item.date,
        lower: item.value,
        upper: upperByDate.get(item.date),
        value: (item.value + upperByDate.get(item.date)) / 2
      }));
    try {
      const links = noteLinks(await fetchWithRetry(CALENDAR_URL), requestedDate);
      if (!links.length) throw new Error('官方会议日历没有可核验的实施公告');
      let policy;
      for (const link of links.slice(0, 2)) {
        const html = await fetchWithRetry(link.url);
        const note = parseNote(html, link.url, link.date);
        if (note.effectiveDate > requestedDate) continue;
        const evidenceDir = path.join(DATA_DIR, 'raw', 'policy-target');
        fs.mkdirSync(evidenceDir, { recursive: true });
        const evidenceFile = path.join(evidenceDir, `${requestedDate}-${Date.now()}.json`);
        policy = { ...note, fetchedAt: new Date().toISOString(), rawEvidence: path.relative(REPO_ROOT, evidenceFile).replaceAll('\\', '/') };
        fs.writeFileSync(evidenceFile, JSON.stringify({ ...policy, html }, null, 2));
        rangeHistory = reconcileRange(rangeHistory, policy, requestedDate);
        break;
      }
      if (!policy) throw new Error('未找到已生效的官方实施公告');
      indicators.federal_funds_target_range.policyDecision = policy;
      state.sourceSuccessCount += 1;
    } catch (error) {
      state.sourceFailureCount += 1;
      state.errors.push({ source: 'Federal Reserve implementation note', indicatorIds: ['federal_funds_target_range'], message: error.message });
      markIndicatorFailure(indicators, ['federal_funds_target_range'], error.message);
      return results;
    }
    setIndicatorHistory(indicators, catalog, 'federal_funds_target_range', rangeHistory, referenceDate, { valueScale: 1 });
    indicators.federal_funds_target_range.sourceName = 'Federal Reserve implementation note + FRED history';
    indicators.federal_funds_target_range.sourceUrl = indicators.federal_funds_target_range.policyDecision.sourceUrl;
    indicators.federal_funds_target_range.formula = 'FRED上下限历史与美联储实施公告交叉核验，按公告生效日纳入目标区间';
    indicators.federal_funds_target_range.rangeHistory = rangeHistory.map(({ date, lower, upper }) => ({ date, lower, upper }));
    indicators.federal_funds_target_range.rangeLow = rangeHistory.at(-1).lower;
    indicators.federal_funds_target_range.rangeHigh = rangeHistory.at(-1).upper;
  } else {
    const message = '联邦基金目标区间上下限未能同时取得，目标区间未刷新';
    state.errors.push({ source: 'FRED derived', indicatorIds: ['federal_funds_target_range'], message });
    markIndicatorFailure(indicators, ['federal_funds_target_range'], message);
  }

  return results;
}

async function fetchBrent(indicators, catalog, referenceDate, requestedDate, state) {
  if (process.env.USD_LIQUIDITY_USE_CHOICE !== '1') {
    const message = 'Choice 尚未启用，布伦特连续期货数据本轮未更新';
    state.errors.push({ source: 'Choice', indicatorIds: ['brent_crude'], message });
    markIndicatorFailure(indicators, ['brent_crude'], message);
    return;
  }
  try {
    const { fetchBrentHistory } = await import('./lib/brent-source.mjs');
    const result = await fetchBrentHistory(requestedDate, { previousHistory: indicators.brent_crude.history });
    if (result.seriesId !== 'B.IPE' || result.sourceSeriesId !== catalog.indicators.brent_crude.sourceSeriesId) {
      throw new Error('布伦特品种或数据源代码不一致');
    }
    setIndicatorHistory(indicators, catalog, 'brent_crude', result.history, referenceDate);
    state.sourceSuccessCount += 1;
  } catch (error) {
    const message = `B.IPE抓取失败，${error.message}`;
    state.errors.push({ source: 'Eastmoney', indicatorIds: ['brent_crude'], message });
    state.sourceFailureCount += 1;
    markIndicatorFailure(indicators, ['brent_crude'], message);
  }
}

async function fetchTga(indicators, catalog, referenceDate, requestedDate, state) {
  const params = {
    fields: 'record_date,account_type,open_today_bal,close_today_bal',
    filter: `record_date:gte:${dateYearsAgo(requestedDate, FISCAL_HISTORY_YEARS, 14)},record_date:lte:${requestedDate}`,
    sort: 'record_date',
  };
  try {
    const rows = await fetchFiscalDataPages(catalog.indicators.tga_balance.sourceUrl, params);
    const history = rows
      .filter((row) => /^(federal reserve account|treasury general account \(tga\))$/i.test(row.account_type || '')
        || /treasury general account.*closing balance/i.test(row.account_type || ''))
      .map((row) => ({
        date: row.record_date,
        value: parseNumber(row.close_today_bal) ?? parseNumber(row.open_today_bal)
      }))
      .filter((item) => item.value !== null);
    if (!history.length) throw new Error('API未返回TGA日终余额记录');
    setIndicatorHistory(indicators, catalog, 'tga_balance', history, referenceDate);
    state.sourceSuccessCount += 1;
  } catch (error) {
    const message = `TGA抓取失败，${error.message}`;
    state.errors.push({ source: 'Fiscal Data', indicatorIds: ['tga_balance'], message });
    state.sourceFailureCount += 1;
    markIndicatorFailure(indicators, ['tga_balance'], message);
  }
}

async function fetchTotalPublicDebt(indicators, catalog, referenceDate, requestedDate, state) {
  const params = {
    fields: 'record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt',
    filter: `record_date:gte:1993-04-01,record_date:lte:${requestedDate}`,
    sort: 'record_date',
  };
  try {
    const rows = await fetchFiscalDataPages(catalog.indicators.total_public_debt_outstanding.sourceUrl, params);
    const history = rows
      .map((row) => ({
        date: row.record_date,
        value: parseNumber(row.tot_pub_debt_out_amt)
      }))
      .filter((item) => item.value !== null);
    if (!history.length) throw new Error('API未返回未偿还公共债务总额记录');
    setIndicatorHistory(indicators, catalog, 'total_public_debt_outstanding', history, referenceDate);
    state.sourceSuccessCount += 1;
  } catch (error) {
    const message = `未偿还公共债务总额抓取失败，${error.message}`;
    state.errors.push({ source: 'Fiscal Data', indicatorIds: ['total_public_debt_outstanding'], message });
    state.sourceFailureCount += 1;
    markIndicatorFailure(indicators, ['total_public_debt_outstanding'], message);
  }
}

async function fetchTreasuryNetIssuance(indicators, catalog, referenceDate, requestedDate, state) {
  const params = {
    fields: 'record_date,security_market,security_type,transaction_type,transaction_today_amt',
    filter: `record_date:gte:${dateYearsAgo(requestedDate, FISCAL_HISTORY_YEARS, 14)},record_date:lte:${requestedDate}`,
    sort: 'record_date',
  };
  try {
    const rows = await fetchFiscalDataPages(catalog.indicators.treasury_net_issuance_5d.sourceUrl, params);
    const daily = new Map();

    for (const row of rows) {
      const market = String(row.security_market || '');
      const securityType = String(row.security_type || '');
      const transactionType = String(row.transaction_type || '');
      if (!/marketable/i.test(market)) continue;
      if (!/(bill|note|bond)/i.test(securityType)) continue;
      if (/inflation.protected.*increment|federal financing bank/i.test(securityType)) continue;
      const amount = parseNumber(row.transaction_today_amt);
      if (amount === null || !/^\d{4}-\d{2}-\d{2}$/.test(row.record_date || '')) continue;

      let signedAmount = null;
      if (/issue/i.test(transactionType)) signedAmount = amount;
      if (/redemption/i.test(transactionType)) signedAmount = -amount;
      if (signedAmount === null) continue;
      daily.set(row.record_date, (daily.get(row.record_date) || 0) + signedAmount / 100);
    }

    const dailyHistory = [...daily.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, value]) => ({ date, value }));
    const history = rollingSum(dailyHistory, 5);
    if (!history.length) throw new Error('API未返回可计算的市场化国债发行与偿还记录');
    setIndicatorHistory(indicators, catalog, 'treasury_net_issuance_5d', history, referenceDate, { valueScale: 1 });
    state.sourceSuccessCount += 1;
  } catch (error) {
    const message = `市场化国债净发行抓取失败，${error.message}`;
    state.errors.push({ source: 'Fiscal Data', indicatorIds: ['treasury_net_issuance_5d'], message });
    state.sourceFailureCount += 1;
    markIndicatorFailure(indicators, ['treasury_net_issuance_5d'], message);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = readJson(CATALOG_PATH);
  if (!catalog?.modules || !catalog?.indicators) throw new Error('指标目录结构无效');

  const generatedAt = new Date();
  const referenceDate = args.referenceDate;
  const previous = readJson(CURRENT_PATH, null);
  const previousById = flattenPrevious(previous, catalog);
  const indicators = {};

  for (const config of Object.values(catalog.indicators)) {
    indicators[config.id] = makeIndicator(config, previousById.get(config.id), referenceDate);
  }

  const state = {
    errors: [],
    sourceSuccessCount: 0,
    sourceFailureCount: 0
  };

  await Promise.all([
    fetchOfr(indicators, catalog, referenceDate, args.requestedDate, state),
    fetchFred(indicators, catalog, referenceDate, args.requestedDate, state),
    fetchBrent(indicators, catalog, referenceDate, args.requestedDate, state),
    fetchTga(indicators, catalog, referenceDate, args.requestedDate, state),
    fetchTreasuryNetIssuance(indicators, catalog, referenceDate, args.requestedDate, state),
    fetchTotalPublicDebt(indicators, catalog, referenceDate, args.requestedDate, state)
  ]);

  const refreshAudit = buildRefreshAudit(indicators, previous, args.requestedDate);
  for (const indicatorId of refreshAudit.regressedIndicatorIds) {
    const item = refreshAudit.indicators.find((row) => row.id === indicatorId);
    const message = `${indicatorId}源端观察日从${item.previousObservationDate}倒退到${item.observationDate}，停止发布`;
    state.errors.push({ source: 'freshness', indicatorIds: [indicatorId], message });
    markIndicatorFailure(indicators, [indicatorId], message);
  }

  const modules = catalog.modules.map((module) => {
    const moduleIndicators = module.indicatorIds.map((id) => indicators[id]);
    return {
      id: module.id,
      title: module.title,
      summary: module.summary,
      status: moduleStatus(moduleIndicators),
      primaryIndicatorId: module.primaryIndicatorId,
      indicators: moduleIndicators
    };
  });

  const allIndicators = Object.values(indicators);
  const usable = allIndicators.filter((item) => item.value !== null);
  const stale = allIndicators.filter((item) => item.status === 'stale');
  const missing = allIndicators.filter((item) => item.status === 'missing');
  const preservedIndicatorIds = allIndicators
    .filter((item) => item.retainedPreviousValue && item.value !== null)
    .map((item) => item.id);

  let overallStatus = 'ok';
  if (!usable.length) overallStatus = 'error';
  else if (stale.length) overallStatus = 'stale';
  else if (missing.length) overallStatus = 'partial';

  const overviewPrimary = modules.map((module) => {
    const primary = module.indicators.find((item) => item.id === module.primaryIndicatorId)
      || module.indicators[0];
    return {
      moduleId: module.id,
      moduleTitle: module.title,
      indicatorId: primary?.id || null,
      name: primary?.name || null,
      value: primary?.value ?? null,
      unit: primary?.unit || null,
      change: primary?.change ?? null,
      changeLabel: primary?.changeLabel || null,
      status: primary?.status || 'missing',
      updatedAt: primary?.updatedAt || null
    };
  });

  const transmission = {
    title: catalog.transmission.title,
    stages: catalog.transmission.stages.map((stage) => {
      const stageIndicators = stage.indicatorIds.map((id) => indicators[id]).filter(Boolean);
      return {
        id: stage.id,
        label: stage.label,
        status: moduleStatus(stageIndicators),
        indicatorIds: stage.indicatorIds
      };
    })
  };

  const output = {
    meta: {
      schemaVersion: catalog.schemaVersion,
      requestedDate: args.requestedDate,
      generatedAt: generatedAt.toISOString(),
      timezone: 'Asia/Shanghai',
      status: overallStatus,
      dataThrough: latestObservationDate(usable),
      sourceSuccessCount: state.sourceSuccessCount,
      sourceFailureCount: state.sourceFailureCount,
      usableIndicatorCount: usable.length,
      staleIndicatorCount: stale.length,
      missingIndicatorCount: missing.length,
      retainedPreviousValues: preservedIndicatorIds,
      errors: state.errors,
      refreshAudit,
      note: '官方源刷新失败时保留已有快照并标记stale。'
    },
    overview: {
      status: overallStatus,
      summary: overallStatus === 'ok'
        ? '官方数据已刷新'
        : overallStatus === 'error'
          ? '当前没有可用官方数据，请检查刷新错误'
          : '部分指标缺失或陈旧，请结合数据日期使用',
      asOf: latestObservationDate(usable),
      primaryIndicators: overviewPrimary
    },
    modules,
    transmission
  };

  atomicWriteJson(CANDIDATE_PATH, output);

  console.log(`候选数据抓取完成  状态 ${overallStatus}`);
  console.log(`成功数据源 ${state.sourceSuccessCount}  失败数据源 ${state.sourceFailureCount}`);
  console.log(`可用指标 ${usable.length}  陈旧指标 ${stale.length}  缺失指标 ${missing.length}`);
  console.log(`观察日期推进 ${refreshAudit.advancedIndicatorCount} 项  源端观察日期未变 ${refreshAudit.unchangedObservationCount} 项`);
  for (const item of refreshAudit.indicators) {
    console.log(`来源观察日 ${item.id} ${item.observationDate || '缺失'}  新增观察 ${item.newObservationCount}`);
  }
  if (preservedIndicatorIds.length) console.log(`候选文件沿用旧值 ${preservedIndicatorIds.join(', ')}`);
  for (const error of state.errors) console.error(`错误  ${error.message}`);
  console.log(`候选文件 ${CANDIDATE_PATH}`);

  if (state.errors.length) console.warn('部分来源未更新，按逐项缺失或陈旧状态继续发布');
}

main().catch((error) => {
  console.error(`刷新失败  ${error.stack || error.message}`);
  process.exitCode = 1;
});
