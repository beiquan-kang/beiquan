export const SCHEMA_VERSION = '1.0.0';
export const SEED_SLUG = 'fed-decision-in-september-762';
export const HISTORY_METHOD = 'Polymarket CLOB 历史价格，60分钟采样；历史序列不与当前报价混算变化';

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const price = (value) => finite(value) && Number(value) >= 0 && Number(value) <= 1 ? Number(value) : null;
export const round = (value) => Math.round(value * 1000000) / 1000000;

export function jsonArray(value, label) {
  const result = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(result)) throw new Error(`${label}不是数组`);
  return result;
}

export function identifyOutcome(market) {
  const names = jsonArray(market.outcomes, 'outcomes');
  const tokens = jsonArray(market.clobTokenIds, 'clobTokenIds');
  const prices = jsonArray(market.outcomePrices, 'outcomePrices');
  const index = names.findIndex((name) => String(name).toLowerCase() === 'yes');
  if (index < 0 || !tokens[index] || names.length !== tokens.length || names.length !== prices.length) {
    throw new Error(`合约 ${market.id} 的 Yes 代币与价格映射无效`);
  }
  const originalLabel = market.groupItemTitle || market.question || '';
  let direction = 'other';
  let label = originalLabel;
  const change = originalLabel.match(/(\d+)(\+)?\s*bps?\s*(increase|decrease)/i);
  if (change) {
    direction = change[3].toLowerCase() === 'increase' ? 'hike' : 'cut';
    label = `${direction === 'hike' ? '加息' : '降息'} ${change[1]} 个基点${change[2] ? '及以上' : ''}`;
  } else if (/no change|unchanged/i.test(originalLabel)) {
    direction = 'hold'; label = '维持不变';
  }
  return { marketId: String(market.id), tokenId: String(tokens[index]), label, originalLabel, direction, gammaPrice: price(prices[index]) };
}

export function selectEvent(events, meetings, now = new Date()) {
  const instant = new Date(now).getTime();
  const futureMeetings = meetings.filter((meeting) => Date.parse(meeting.decisionAt) > instant)
    .sort((a, b) => a.decisionAt.localeCompare(b.decisionAt));
  const nextMeeting = futureMeetings[0];
  if (!nextMeeting) throw new Error('官方日历中没有可核验的下一次 FOMC 决议时间');
  const candidates = events.filter((event) => event.closed !== true && event.archived !== true
    && /^Fed (Decision|Interest Rates)/i.test(event.title || '')
    && eventMeetingDate(event.endDate) === nextMeeting.meetingDate);
  if (candidates.length !== 1) throw new Error(`下一次会议 ${nextMeeting.meetingDate} 未匹配唯一开放 Polymarket 事件`);
  return { event: candidates[0], meeting: nextMeeting };
}

function eventMeetingDate(endDate) {
  if (typeof endDate !== 'string') return null;
  const instant = new Date(endDate);
  if (!Number.isFinite(instant.getTime())) return null;
  // Gamma also uses UTC midnight as a date-only placeholder. Actual deadlines
  // belong to the US meeting date, including 23:59 ET on the next UTC day.
  if (/T00:00:00(?:\.0+)?(?:Z|\+00:00)$/.test(endDate)) return endDate.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

export function currentQuote(market, book, gammaPrice) {
  const bids = (book?.bids || []).filter((item) => price(item.price) !== null && Number(item.size) > 0).map((item) => Number(item.price));
  const asks = (book?.asks || []).filter((item) => price(item.price) !== null && Number(item.size) > 0).map((item) => Number(item.price));
  const bestBid = bids.length ? Math.max(...bids) : null;
  const bestAsk = asks.length ? Math.min(...asks) : null;
  const spread = bestBid !== null && bestAsk !== null ? round(bestAsk - bestBid) : null;
  if (spread !== null && spread < 0) throw new Error(`合约 ${market.id} 买价高于卖价`);
  const bookLast = price(book?.last_trade_price);
  const gammaLast = price(market.lastTradePrice);
  let value = null;
  let priceMethod = 'unavailable';
  if (spread !== null && spread <= 0.10) { value = (bestBid + bestAsk) / 2; priceMethod = 'clob_midpoint'; }
  else if (bookLast !== null) { value = bookLast; priceMethod = 'clob_last_trade'; }
  else if (gammaPrice !== null) { value = gammaPrice; priceMethod = 'gamma_outcome_price'; }
  return {
    probability: value === null ? null : round(value * 100), priceMethod,
    bestBid, bestAsk, spread, lastTradePrice: bookLast ?? gammaLast,
    quoteAt: finite(book?.timestamp) ? new Date(Number(book.timestamp)).toISOString() : null,
    volume24h: finite(market.volume24hr) ? Number(market.volume24hr) : null,
  };
}

export function normalizeHistory(payload, now = new Date()) {
  if (!Array.isArray(payload?.history)) throw new Error('CLOB 历史接口缺少 history 数组');
  const end = new Date(now).getTime();
  const start = end - 32 * 86400000;
  const unique = new Map();
  for (const point of payload.history) {
    const stamp = Number(point.t) * 1000;
    if (!Number.isFinite(stamp) || price(point.p) === null) throw new Error('CLOB 历史接口存在无效时间或概率');
    if (stamp > end + 300000) throw new Error('CLOB 历史接口包含未来观测');
    if (stamp >= start && stamp <= end) unique.set(stamp, round(Number(point.p) * 100));
  }
  return [...unique].sort(([a], [b]) => a - b).map(([stamp, value]) => [new Date(stamp).toISOString(), value]);
}

export function historyStatus(history, now = new Date()) {
  if (history.length < 2) return 'unavailable';
  const stamps = history.map(([time]) => Date.parse(time));
  const span = stamps.at(-1) - stamps[0];
  const age = new Date(now).getTime() - stamps.at(-1);
  const hasGap = stamps.some((time, index) => index > 0 && time - stamps[index - 1] > 6 * 3600000);
  return span >= 27 * 86400000 && age <= 6 * 3600000 && !hasGap ? 'ok' : 'partial';
}

export function calculateChanges(outcome, eventId, snapshots, now) {
  const current = Date.parse(now);
  const result = {};
  for (const [field, hours, tolerance] of [['change24hPp', 24, 2], ['change7dPp', 168, 6]]) {
    const target = current - hours * 3600000;
    const candidates = snapshots.filter((snapshot) => snapshot.meeting?.eventId === eventId
      && ['ok', 'partial'].includes(snapshot.meta?.status)
      && Math.abs(Date.parse(snapshot.meta.generatedAt) - target) <= tolerance * 3600000)
      .sort((a, b) => Math.abs(Date.parse(a.meta.generatedAt) - target) - Math.abs(Date.parse(b.meta.generatedAt) - target));
    const baseline = candidates.map((snapshot) => snapshot.outcomes.find((item) => item.tokenId === outcome.tokenId
      && item.priceMethod === outcome.priceMethod && item.probability !== null)).find(Boolean);
    result[field] = outcome.probability !== null && baseline ? round(outcome.probability - baseline.probability) : null;
  }
  return result;
}

export function validatePayload(payload) {
  if (payload.meta?.schemaVersion !== SCHEMA_VERSION || !/^\d{4}-\d{2}-\d{2}$/.test(payload.meta?.requestedDate || '')
    || !Number.isFinite(Date.parse(payload.meta.generatedAt)) || !Array.isArray(payload.outcomes)) throw new Error('议息概率数据契约无效');
  if (payload.meta.status === 'unavailable') {
    if (payload.outcomes.length || payload.hikeProbability !== null) throw new Error('不可用状态不得携带看似有效的概率');
    return payload;
  }
  if (!payload.meeting?.eventId || !payload.meeting?.decisionAt || payload.outcomes.length < 2) throw new Error('会议或结果选项不完整');
  const tokens = new Set();
  for (const item of payload.outcomes) {
    if (!item.tokenId || tokens.has(item.tokenId)) throw new Error('Yes 代币身份缺失或重复');
    tokens.add(item.tokenId);
    if (item.probability !== null && (!Number.isFinite(item.probability) || item.probability < 0 || item.probability > 100)) throw new Error('概率越界');
    let previous = '';
    for (const [stamp, value] of item.history) {
      if (stamp <= previous || !Number.isFinite(Date.parse(stamp)) || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('历史概率数据无效');
      previous = stamp;
    }
  }
  return payload;
}
