'use strict';

const CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

function noteLinks(html, requestedDate) {
  return [...new Set(html.match(/\/newsevents\/pressreleases\/monetary\d{8}a1\.htm/g) || [])]
    .map(url => ({ url: `https://www.federalreserve.gov${url}`, date: url.match(/(\d{4})(\d{2})(\d{2})a1/).slice(1).join('-') }))
    .filter(note => note.date <= requestedDate).sort((a, b) => b.date.localeCompare(a.date));
}

function rate(text) {
  const match = text.trim().match(/^(\d+)(?:-(\d+)\/(\d+))?$/);
  if (match) return Number(match[1]) + (match[2] ? Number(match[2]) / Number(match[3]) : 0);
  if (/^\d+\.\d+$/.test(text.trim())) return Number(text);
  throw new Error(`无法解析官方目标利率 ${text}`);
}

function parseNote(html, sourceUrl, announcementDate) {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
  const effective = text.match(/Effective ([A-Za-z]+ \d{1,2}, \d{4}), the Federal Open Market Committee directs the Desk to:/i);
  const target = text.match(/federal funds rate in a target range of ([\d./-]+) to ([\d./-]+) percent/i);
  if (!effective || !target) throw new Error('官方实施公告缺少生效日或目标区间');
  const date = new Date(`${effective[1]} 00:00:00 GMT`);
  if (!Number.isFinite(date.getTime())) throw new Error('官方实施公告生效日无效');
  const note = { sourceUrl, announcementDate, effectiveDate: date.toISOString().slice(0, 10), lower: rate(target[1]), upper: rate(target[2]) };
  if (note.lower > note.upper || note.upper - note.lower > 1 || note.effectiveDate < announcementDate) throw new Error('官方目标区间或生效日异常');
  return note;
}

function reconcileRange(rangeHistory, note, requestedDate) {
  if (note.effectiveDate > requestedDate) return rangeHistory;
  const later = rangeHistory.filter(point => point.date >= note.effectiveDate);
  if (later.some(point => point.lower !== note.lower || point.upper !== note.upper)) throw new Error('FRED目标区间与已生效的美联储实施公告冲突');
  if (later.some(point => point.date === note.effectiveDate)) return rangeHistory;
  return [...rangeHistory, { date: note.effectiveDate, lower: note.lower, upper: note.upper, value: (note.lower + note.upper) / 2 }].sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { CALENDAR_URL, noteLinks, parseNote, reconcileRange };
