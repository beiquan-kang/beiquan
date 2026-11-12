import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicFetch } from '../lib/http.mjs';
import { SCHEMA_VERSION, SEED_SLUG, HISTORY_METHOD, identifyOutcome, selectEvent, currentQuote, normalizeHistory, historyStatus, calculateChanges, validatePayload, round } from './model.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataRoot = path.join(repoRoot, 'data/fed-expectations');
const currentPath = path.join(dataRoot, 'current.json');
const publicPath = path.join(repoRoot, 'public/data/fed-expectations-current.js');
const gamma = 'https://gamma-api.polymarket.com';
const clob = 'https://clob.polymarket.com';

async function readPreviousSnapshots(now = new Date()) {
  const directory = path.join(dataRoot, 'snapshots');
  let files;
  try { files = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const cutoff = new Date(new Date(now).getTime() - 10 * 86400000).toISOString().slice(0, 10);
  return Promise.all(files.filter((name) => name.endsWith('.json') && name.slice(0, 10) >= cutoff).sort().map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))));
}

export async function publishFiles(files, afterPublish = async () => {}, fsImpl = fs) {
  const previous = await Promise.all(files.map(async ({ file }) => {
    try { return await fsImpl.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  const stages = files.map(({ file }) => `${file}.tmp-${randomUUID()}`);
  try {
    for (const [index, item] of files.entries()) await fsImpl.writeFile(stages[index], item.content);
    for (const [index, item] of files.entries()) await fsImpl.rename(stages[index], item.file);
    for (const item of files) {
      if ((await fsImpl.readFile(item.file, 'utf8')) !== item.content) throw new Error('议息概率发布文件回读不一致');
    }
    await afterPublish();
  } catch (error) {
    const failed = [];
    for (const [index, item] of files.entries()) {
      try {
        if (previous[index] === null) await fsImpl.rm(item.file, { force: true });
        else await fsImpl.writeFile(item.file, previous[index]);
      } catch (rollbackError) { failed.push(`${item.file} ${rollbackError.message}`); }
    }
    if (failed.length) throw new Error(`${error.message}；恢复正式文件失败 ${failed.join('；')}`);
    throw error;
  } finally {
    for (const stage of stages) await fsImpl.rm(stage, { force: true }).catch(() => {});
  }
}

export async function collectExpectations({ requestedDate, now = new Date(), fetchImpl = publicFetch, snapshots = [], calendarLoader, meetingLoader } = {}) {
  const generatedAt = new Date(now).toISOString();
  const raw = [];
  const errors = [];
  const warnings = [];
  const recordingFetch = async (url, options = {}) => {
    const startedAt = new Date().toISOString();
    try {
      const response = await fetchImpl(url, options);
      const content = await response.text();
      raw.push({ url: String(url), retrievedAt: new Date().toISOString(), status: response.status, content });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Response(content, { status: response.status });
    } catch (error) {
      raw.push({ url: String(url), retrievedAt: startedAt, error: error.message });
      throw error;
    }
  };
  const json = async (url) => (await recordingFetch(url)).json();
  if (!calendarLoader || !meetingLoader) {
    const module = await import('../fed-calendar/index.mjs');
    calendarLoader ??= module.fetchFedCalendar;
    meetingLoader ??= module.fetchFomcMeetings;
  }
  const result = {
    meta: {
      schemaVersion: SCHEMA_VERSION, requestedDate, generatedAt, timezone: 'Asia/Shanghai', status: 'unavailable',
      probabilityUnit: 'percent', quoteUnit: 'USD_per_share', historyMethod: HISTORY_METHOD,
      changeMethod: '同事件同 Yes 代币同报价口径的本地快照差，24小时容差2小时，7天容差6小时；历史不足留空',
      sourceName: 'Polymarket', sourceUrl: `https://polymarket.com/event/${SEED_SLUG}`, errors, warnings,
    },
    meeting: null, outcomes: [], hikeProbability: null, switchedFromEventId: null, calendar: null,
  };
  const results = await Promise.allSettled([
    json(`${gamma}/events/slug/${SEED_SLUG}`),
    calendarLoader({ now: new Date(now), fetchImpl: recordingFetch }),
    meetingLoader({ now: new Date(now), fetchImpl: recordingFetch }),
  ]);
  if (results[1].status === 'fulfilled') result.calendar = results[1].value;
  else {
    result.calendar = { fetchedAt: generatedAt, status: 'unavailable', events: [], warnings: [results[1].reason.message] };
    warnings.push('官方日历读取失败，暂不展示未经核验的事件时间');
  }
  try {
    if (results[0].status === 'rejected') throw results[0].reason;
    if (results[2].status === 'rejected') throw results[2].reason;
    const seed = results[0].value;
    const schedule = results[2].value;
    const meetings = Array.isArray(schedule) ? schedule : schedule.meetings;
    if (!Array.isArray(meetings)) throw new Error('官方 FOMC 日历结构无效');
    const series = (seed.series || []).find((item) => item.slug === 'fomc' || item.title === 'FOMC');
    if (!series?.id) throw new Error('种子事件未提供可核验的 FOMC 关联 series');
    const related = await json(`${gamma}/series/${encodeURIComponent(series.id)}`);
    if (!Array.isArray(related.events)) throw new Error('FOMC series 未返回关联事件列表');
    const { event: selected, meeting } = selectEvent(related.events, meetings, now);
    const event = String(selected.id) === String(seed.id) ? seed : await json(`${gamma}/events/${encodeURIComponent(selected.id)}`);
    if (event.closed === true || !Array.isArray(event.markets) || event.markets.length < 2 || event.markets.every((item) => item.closed === true)) {
      throw new Error('下一次议息市场已关闭或完整结果选项暂不可用');
    }
    const sourceUrl = `https://polymarket.com/event/${event.slug}`;
    result.meeting = {
      eventId: String(event.id), slug: event.slug, title: '下一次 FOMC 议息', originalTitle: event.title,
      seriesId: String(series.id), meetingDate: meeting.meetingDate, decisionAt: meeting.decisionAt,
      decisionAtBeijing: meeting.decisionAtBeijing, sourceUrl, calendarSourceUrl: meeting.sourceUrl,
      sourceUpdatedAt: event.updatedAt ?? null, volume24h: Number.isFinite(Number(event.volume24hr)) ? Number(event.volume24hr) : null,
    };
    result.meta.sourceUrl = sourceUrl;
    const previous = [...snapshots].sort((a, b) => b.meta.generatedAt.localeCompare(a.meta.generatedAt)).find((item) => item.meeting?.eventId);
    result.switchedFromEventId = previous && previous.meeting.eventId !== result.meeting.eventId ? previous.meeting.eventId : null;
    if (result.switchedFromEventId) warnings.push('已切换至下一次会议，概率变化只比较同一事件');
    // Three concurrent outcomes bound network/process use while keeping each pair independent.
    const queue = [...event.markets];
    const outcomes = [];
    const worker = async () => {
      while (queue.length) {
        const market = queue.shift();
        const identity = identifyOutcome(market);
        const reads = await Promise.allSettled([
          json(`${clob}/book?token_id=${encodeURIComponent(identity.tokenId)}`),
          json(`${clob}/prices-history?market=${encodeURIComponent(identity.tokenId)}&interval=1m&fidelity=60`),
        ]);
        const book = reads[0].status === 'fulfilled' ? reads[0].value : null;
        if (book && String(book.asset_id) !== identity.tokenId) throw new Error(`合约 ${identity.marketId} 订单簿代币身份不一致`);
        if (reads[0].status === 'rejected') warnings.push(`${identity.label} 订单簿不可用，保留 Gamma 报告价格并标明口径`);
        const quote = currentQuote(market, book, identity.gammaPrice);
        let history = [];
        if (reads[1].status === 'fulfilled') history = normalizeHistory(reads[1].value, now);
        else warnings.push(`${identity.label} 历史价格暂不可用`);
        const { gammaPrice, ...fields } = identity;
        const outcome = { ...fields, ...quote, sourceUrl, sourceUpdatedAt: market.updatedAt ?? null,
          history, historyStatus: historyStatus(history, now), historyMethod: HISTORY_METHOD,
          historyStart: history[0]?.[0] ?? null, historyEnd: history.at(-1)?.[0] ?? null,
          change24hPp: null, change7dPp: null,
        };
        Object.assign(outcome, calculateChanges(outcome, result.meeting.eventId, snapshots, generatedAt));
        outcomes.push(outcome);
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(3, queue.length) }, worker));
    const failedWorker = workers.find((item) => item.status === 'rejected');
    if (failedWorker) throw failedWorker.reason;
    result.outcomes = outcomes.sort((a, b) => event.markets.findIndex((item) => String(item.id) === a.marketId) - event.markets.findIndex((item) => String(item.id) === b.marketId));
    const hikes = outcomes.filter((item) => item.direction === 'hike');
    if (hikes.length && hikes.every((item) => item.probability !== null)) result.hikeProbability = round(hikes.reduce((sum, item) => sum + item.probability, 0));
    if (result.hikeProbability > 100) { warnings.push('加息各档报价合计超过100%，暂不展示合计概率'); result.hikeProbability = null; }
    if (outcomes.every((item) => item.probability === null)) throw new Error('所有结果的当前概率均不可用');
    if (outcomes.some((item) => item.historyStatus !== 'ok')) warnings.push('部分选项没有完整近月历史，缺失区间不补值');
    if (outcomes.some((item) => item.change24hPp === null || item.change7dPp === null)) warnings.push('本地同口径历史快照不足，24小时或7天变化暂缺');
    result.meta.status = outcomes.some((item) => item.probability === null || item.historyStatus !== 'ok' || item.priceMethod === 'gamma_outcome_price')
      || result.calendar?.status !== 'ok' ? 'partial' : 'ok';
  } catch (error) {
    errors.push(error.message);
    result.meta.status = 'unavailable'; result.meeting = null; result.outcomes = []; result.hikeProbability = null;
  }
  validatePayload(result);
  return { payload: result, raw };
}

export async function refresh(requestedDate, options = {}) {
  const parsed = new Date(`${requestedDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== requestedDate) throw new Error('日期必须是有效 YYYY-MM-DD');
  const snapshots = await readPreviousSnapshots(options.now ?? new Date());
  const { payload, raw } = await collectExpectations({ requestedDate, snapshots, ...options });
  const stamp = payload.meta.generatedAt.replace(/[:.]/g, '-');
  const rawPath = path.join(dataRoot, 'raw', `${stamp}.json`);
  payload.meta.rawEvidence = path.relative(repoRoot, rawPath).replaceAll('\\', '/');
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'snapshots'), { recursive: true });
  await fs.mkdir(path.dirname(publicPath), { recursive: true });
  await fs.writeFile(rawPath, `${JSON.stringify({ requestedDate, generatedAt: payload.meta.generatedAt, requests: raw }, null, 2)}\n`);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await publishFiles([
    { file: currentPath, content: serialized },
    { file: publicPath, content: `globalThis.__FED_EXPECTATIONS__ = ${JSON.stringify(payload).replaceAll('<', '\\u003c')};\n` },
    { file: path.join(dataRoot, 'snapshots', `${stamp}.json`), content: serialized },
  ], async () => {
    if (process.env.FED_EXPECTATIONS_SKIP_SITE_BUILD !== '1') {
      const { buildDashboard } = await import('../build.mjs');
      await buildDashboard(repoRoot);
    }
  });
  console.log(`议息概率更新完成 ${requestedDate}，状态 ${payload.meta.status}，会议 ${payload.meeting?.meetingDate ?? '不可用'}，选项 ${payload.outcomes.length}`);
  for (const message of payload.meta.errors) console.warn(`议息概率来源暂不可用 ${message}`);
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1) { console.error('用法 node scripts/fed-expectations/refresh.mjs YYYY-MM-DD'); process.exitCode = 2; }
  else await refresh(args[0]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
