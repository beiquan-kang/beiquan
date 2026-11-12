import fs from 'node:fs/promises';

const FED_BASE = 'https://www.federalreserve.gov/newsevents/';
const BEA_ICS = 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics';
const BLS_ICS = 'https://www.bls.gov/schedule/news_release/bls.ics';
const BLS_META = [
  { pattern: /Employment Situation/i, code: 'empsit', title: '非农就业报告', importance: 1 },
  { pattern: /Consumer Price Index/i, code: 'cpi', title: 'CPI通胀', importance: 1 },
  { pattern: /Producer Price Index/i, code: 'ppi', title: 'PPI生产者价格', importance: 2 },
  { pattern: /Employment Cost Index/i, code: 'eci', title: 'ECI雇佣成本', importance: 2 },
  { pattern: /Job Openings and Labor Turnover/i, code: 'jolts', title: 'JOLTS职位空缺', importance: 3 },
];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY = 86400000;
const requestCaches = new WeakMap();

function clean(value) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function parts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function beijingTime(value) {
  const p = parts(new Date(value), 'Asia/Shanghai');
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function easternToUtc(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let stamp = target;
  for (let i = 0; i < 3; i += 1) {
    const p = parts(new Date(stamp), 'America/New_York');
    const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    stamp += target - represented;
  }
  const verified = parts(new Date(stamp), 'America/New_York');
  if (`${verified.year}-${verified.month}-${verified.day}` !== date || `${verified.hour}:${verified.minute}` !== time) throw new Error('无效美东日期或时间');
  return new Date(stamp).toISOString();
}

function event(id, title, startsAt, importance, sourceUrl, extra = {}) {
  return { id, title, startsAt, beijingTime: beijingTime(startsAt), importance, sourceUrl, ...extra };
}

async function read(url, fetchImpl) {
  let cache = requestCaches.get(fetchImpl);
  if (!cache) { cache = new Map(); requestCaches.set(fetchImpl, cache); }
  const previous = cache.get(url);
  if (previous && Date.now() - previous.at < 60000) return previous.promise;
  const promise = (async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'text/calendar,text/html;q=0.9,*/*;q=0.8' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  })();
  cache.set(url, { at: Date.now(), promise });
  try { return await promise; } catch (error) { cache.delete(url); throw error; }
}

function monthUrl(year, month) { return `${FED_BASE}${year}-${MONTHS[month - 1]}.htm`; }

function monthWindow(now, count) {
  const p = parts(new Date(now), 'America/New_York');
  return Array.from({ length: count }, (_, index) => {
    const d = new Date(Date.UTC(+p.year, +p.month - 1 + index, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });
}

export function parseFedMonth(html, year, month) {
  if (!html.includes('cal-nojs__rowTitle')) throw new Error('Fed月历结构未识别');
  const events = [];
  const row = /<div\s+class="col-xs-2"[^>]*>([\s\S]*?)<\/div>\s*<div\s+class="col-xs-7"[^>]*>([\s\S]*?)<\/div>\s*<div\s+class="col-xs-3"[^>]*>([\s\S]*?)<\/div>/g;
  for (const match of html.matchAll(row)) {
    const rawTitle = clean(match[2]);
    let kind, title, importance;
    if (/^FOMC Press Conference\b/.test(rawTitle)) { kind = 'press-conference'; title = '美联储主席记者会'; importance = 1; }
    else if (/^FOMC Meeting\b/.test(rawTitle)) { kind = 'decision'; title = 'FOMC利率决议'; importance = 1; }
    else if (/^FOMC Minutes\b/.test(rawTitle)) { kind = 'minutes'; title = 'FOMC会议纪要'; importance = 2; }
    else if (/^Beige Book\b/.test(rawTitle)) { kind = 'beige-book'; title = '美联储经济褐皮书'; importance = 3; }
    else continue;
    const time = clean(match[1]).match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
    const day = clean(match[3]);
    if (!time || !/^\d{1,2}$/.test(day)) throw new Error(`Fed事件时间无法解析 ${rawTitle}`);
    const date = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
    const hour = Number(time[1]) % 12 + (time[3].toLowerCase() === 'p' ? 12 : 0);
    const startsAt = easternToUtc(date, `${String(hour).padStart(2, '0')}:${time[2]}`);
    events.push(event(`fed-${kind}-${date}`, title, startsAt, importance, monthUrl(year, month), { kind, meetingDate: date }));
  }
  return events;
}

export function parseBeaIcs(text) {
  if (!text.includes('BEGIN:VCALENDAR') || !text.includes('END:VCALENDAR')) throw new Error('BEA日历格式无效');
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const events = [];
  for (const [, body] of unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)) {
    if (/^STATUS:CANCELLED\s*$/m.test(body)) continue;
    const summary = body.match(/^SUMMARY(?:;[^:]*)?:(.*)$/m)?.[1]?.trim().replace(/\\([,;\\])/g, '$1');
    let kind, title, importance;
    if (/^Personal Income and Outlays/i.test(summary || '')) { kind = 'pce'; title = 'PCE通胀与个人收支'; importance = 1; }
    else if (/^(?:GDP \(|Gross Domestic Product)/i.test(summary || '')) { kind = 'gdp'; title = /Advance Estimate/i.test(summary) ? '美国GDP初值' : /Second Estimate/i.test(summary) ? '美国GDP第二次估计' : '美国GDP第三次估计'; importance = 3; }
    else continue;
    const dt = body.match(/^DTSTART(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\s*$/m);
    if (!dt) throw new Error(`BEA事件缺少UTC发布时间 ${summary}`);
    const startsAt = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}:${dt[5]}:${dt[6]}.000Z`;
    if (!Number.isFinite(Date.parse(startsAt))) throw new Error('BEA事件日期无效');
    events.push(event(`bea-${kind}-${startsAt.slice(0, 10)}`, title, startsAt, importance, 'https://www.bea.gov/news/schedule', { sourceTitle: summary, kind }));
  }
  if (!events.length) throw new Error('BEA日历未找到PCE或GDP事件');
  return events;
}

export function parseBlsIcs(text) {
  if (!text.includes('BEGIN:VCALENDAR') || !text.includes('END:VCALENDAR')) throw new Error('BLS日历格式无效');
  const events = [];
  for (const [, body] of text.replace(/\r?\n[ \t]/g, '').matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)) {
    if (/^STATUS:CANCELLED\s*$/m.test(body)) continue;
    const summary = body.match(/^SUMMARY(?:;[^:]*)?:(.*)$/m)?.[1] || '';
    const meta = BLS_META.find((item) => item.pattern.test(summary));
    if (!meta) continue;
    const dt = body.match(/^DTSTART(;[^:]*)?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?\s*$/m);
    if (!dt) throw new Error(`BLS事件缺少发布时间 ${meta.code}`);
    const date = `${dt[2]}-${dt[3]}-${dt[4]}`;
    // Floating BLS schedule times are Eastern, as specified by the source calendar.
    if (!dt[8] && dt[1] && !/TZID=(?:US\/Eastern|US-Eastern|America\/New_York|Eastern Standard Time)/i.test(dt[1])) throw new Error('BLS日历时区未识别');
    const startsAt = dt[8] ? `${date}T${dt[5]}:${dt[6]}:${dt[7]}.000Z` : easternToUtc(date, `${dt[5]}:${dt[6]}`);
    events.push(event(`bls-${meta.code}-${date}`, meta.title, startsAt, meta.importance, `https://www.bls.gov/schedule/news_release/${meta.code}.htm`, { sourceMode: 'live', sourceTitle: summary.trim() }));
  }
  if (!events.length) throw new Error('BLS日历未找到相关事件');
  return events;
}

export async function fetchBlsCalendar({ now = new Date(), fetchImpl = fetch, cacheLoader = async () => JSON.parse(await fs.readFile(new URL('../../data/fed-calendar/bls-verified.json', import.meta.url), 'utf8')) } = {}) {
  try {
    const events = parseBlsIcs(await read(BLS_ICS, fetchImpl));
    if (!events.some((item) => Date.parse(item.startsAt) > +new Date(now))) throw new Error('BLS日历未提供未来事件');
    return { status: 'ok', events, warnings: [] };
  } catch (error) {
    let cache;
    try { cache = await cacheLoader(); } catch { cache = null; }
    const expiresAt = Date.parse(cache?.expiresAt), verifiedAt = Date.parse(cache?.verifiedAt);
    if (!cache || !Number.isFinite(expiresAt) || !Number.isFinite(verifiedAt) || expiresAt <= verifiedAt || expiresAt - verifiedAt > 7 * DAY || !Array.isArray(cache.events) || expiresAt <= +new Date(now) || verifiedAt > +new Date(now)) {
      return { status: 'unavailable', events: [], warnings: ['BLS官方日历暂不可用，且没有有效核验缓存，CPI、非农等事件暂缺'] };
    }
    const events = cache.events.map((item) => event(`bls-${item.code}-${item.date}`, item.title, easternToUtc(item.date, item.time), item.importance, `https://www.bls.gov/schedule/news_release/${item.code}.htm`, { sourceMode: 'verified-cache', verifiedAt: cache.verifiedAt, expiresAt: cache.expiresAt }));
    return { status: 'partial', events, warnings: [`BLS官方日历暂无法直连，排期按${beijingTime(cache.verifiedAt)}北京时间核验；缓存截至${beijingTime(cache.expiresAt)}，届时未能复核的条目停止展示`] };
  }
}

function future(events, now, horizonDays, limit) {
  const timestamp = new Date(now).getTime();
  return events.filter((item) => Date.parse(item.startsAt) > timestamp && Date.parse(item.startsAt) <= timestamp + horizonDays * DAY)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.importance - b.importance).slice(0, limit);
}

function meetingsFrom(events, now) {
  return events.filter((item) => item.kind === 'decision' && Date.parse(item.startsAt) > +new Date(now))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((item) => ({ meetingDate: item.meetingDate, decisionAt: item.startsAt, decisionAtBeijing: item.beijingTime, sourceUrl: item.sourceUrl }));
}

async function fetchFedMonths(now, count, fetchImpl) {
  const months = monthWindow(now, count);
  const results = await Promise.allSettled(months.map(async ({ year, month }) => parseFedMonth(await read(monthUrl(year, month), fetchImpl), year, month)));
  return { events: results.flatMap((item) => item.status === 'fulfilled' ? item.value : []), failedMonths: results.flatMap((item, index) => item.status === 'rejected' ? [`${months[index].year}-${String(months[index].month).padStart(2, '0')}`] : []), warnings: results.flatMap((item, index) => item.status === 'rejected' ? [`Fed ${months[index].year}-${months[index].month} 日历获取失败，${item.reason.message}`] : []) };
}

export async function fetchFomcMeetings({ now = new Date(), fetchImpl = fetch } = {}) {
  const result = await fetchFedMonths(now, 4, fetchImpl);
  const meetings = meetingsFrom(result.events, now);
  if (meetings.length && result.failedMonths.some((month) => month <= meetings[0].meetingDate.slice(0, 7))) {
    return { fetchedAt: new Date(now).toISOString(), status: 'unavailable', meetings: [], warnings: [...result.warnings, '较早月份日历缺失，无法排除更近会议，不跳至较远会议'] };
  }
  if (!meetings.length) result.warnings.push('没有可核验的未来FOMC决议时间');
  return { fetchedAt: new Date(now).toISOString(), status: !meetings.length ? 'unavailable' : result.warnings.length ? 'partial' : 'ok', meetings, warnings: result.warnings };
}

export async function fetchFedCalendar({ now = new Date(), horizonDays = 35, limit = 10, fetchImpl = fetch } = {}) {
  const [fed, bea, bls] = await Promise.allSettled([
    fetchFedMonths(now, Math.ceil(horizonDays / 28) + 1, fetchImpl),
    read(BEA_ICS, fetchImpl).then(parseBeaIcs),
    fetchBlsCalendar({ now, fetchImpl })
  ]);
  const warnings = [];
  let all = [];
  if (fed.status === 'fulfilled') { all.push(...fed.value.events); warnings.push(...fed.value.warnings); }
  else warnings.push(`Fed日历获取失败，${fed.reason.message}`);
  if (bea.status === 'fulfilled') all.push(...bea.value);
  else warnings.push(`BEA日历获取失败，${bea.reason.message}`);
  if (bls.status === 'fulfilled') { all.push(...bls.value.events); warnings.push(...bls.value.warnings); }
  else warnings.push(`BLS日历获取失败，${bls.reason.message}`);
  const events = future(all, now, horizonDays, limit);
  return { fetchedAt: new Date(now).toISOString(), status: events.length ? warnings.length ? 'partial' : 'ok' : 'unavailable', events, fomcMeetings: meetingsFrom(all, now), warnings };
}
