import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { compactUsLiquiditySnapshot, flattenIndicators, validateUsLiquiditySnapshot } from './us-liquidity-data/lib/snapshot.mjs';
import { validateRateSnapshot } from './rate-data/lib/rate-snapshot.mjs';
import { validatePayload } from './fed-expectations/model.mjs';
import { renderRateChart } from './lib/render-rate.mjs';
import { treasuryContext } from '../src/lib/treasury-context.mjs';
import { readOptionalJson } from './lib/runtime.mjs';

export const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const jsonForScript = (value) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

async function promote(files) {
  const previous = await Promise.all(files.map(async ({ file }) => {
    try { return await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  const token = randomUUID();
  const stages = files.map(({ file }) => `${file}.tmp-${token}`);
  try {
    for (const [index, entry] of files.entries()) {
      await fs.mkdir(path.dirname(entry.file), { recursive: true });
      await fs.writeFile(stages[index], entry.content);
    }
    for (const [index, entry] of files.entries()) await fs.rename(stages[index], entry.file);
    for (const entry of files) {
      if ((await fs.readFile(entry.file, 'utf8')) !== entry.content) throw new Error('页面发布后回读内容不一致');
    }
  } catch (error) {
    const failures = [];
    for (const [index, entry] of files.entries()) {
      try {
        if (previous[index] === null) await fs.rm(entry.file, { force: true });
        else await fs.writeFile(entry.file, previous[index]);
      } catch (restoreError) { failures.push(restoreError.message); }
    }
    throw new Error(`${error.message}${failures.length ? `；恢复失败 ${failures.join('；')}` : ''}`);
  } finally {
    for (const stage of stages) await fs.rm(stage, { force: true }).catch(() => {});
  }
}

export function parseAssignment(text) {
  const value = text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, '');
  return JSON.parse(value);
}

export async function buildDashboard(root) {
  const read = (relative) => fs.readFile(path.join(root, relative), 'utf8');
  const [currentText, webText, fedText, fedWebText, shell, baseCss, dashboardCss, rateCss, dashboardJs, fedJs, rateJs] = await Promise.all([
    read('data/us-liquidity/current.json'), read('public/data/us-liquidity-current.js'),
    read('data/fed-expectations/current.json'), read('public/data/fed-expectations-current.js'),
    read('src/dashboard.html'), read('src/styles/base.css'), read('src/styles/dashboard.css'), read('src/styles/rates.css'),
    read('src/scripts/us-liquidity-dashboard.js'), read('src/scripts/fed-expectations.js'), read('src/scripts/rate-charts.js'),
  ]);
  const current = JSON.parse(currentText);
  validateUsLiquiditySnapshot(current, { requireDailySummary: true });
  const compact = compactUsLiquiditySnapshot(current);
  if (JSON.stringify(parseAssignment(webText)) !== JSON.stringify(compact)) throw new Error('完整数据与网页数据不一致');
  const fed = JSON.parse(fedText);
  validatePayload(fed);
  if (JSON.stringify(parseAssignment(fedWebText)) !== JSON.stringify(fed)) throw new Error('议息完整数据与网页数据不一致');
  const rates = await readOptionalJson(path.join(root, 'data/rate-data/current.json'), fs);
  if (rates) validateRateSnapshot(rates);
  if (!shell.includes('data-us-liquidity-dashboard') || shell.split('<!--USD_RATE_CHART-->').length !== 2) {
    throw new Error('页面模板不完整');
  }
  const update = await readOptionalJson(path.join(root, 'data/update-state.json'), fs);
  const requestedDate = update?.requestedDate ?? current.meta.requestedDate;
  const indicators = [...flattenIndicators(current).values()];
  const absent = indicators.filter((indicator) => indicator.status === 'missing');
  const retained = indicators.filter((indicator) => indicator.retainedPreviousValue);
  const lastCore = update?.columns?.core;
  const lastFed = update?.columns?.fed;
  const lastRates = update?.columns?.rates;
  const coreNotUpdated = lastCore?.state === 'failed' || current.meta.requestedDate !== requestedDate || Boolean(current.meta.initializedOnly);
  const rateNotUpdated = !rates || lastRates?.state !== 'updated' || rates.requestedDate !== requestedDate;
  const fedNotUpdated = lastFed?.state === 'failed' || fed.meta.requestedDate !== requestedDate || Boolean(fed.meta.initializedOnly);
  const coreStatus = current.meta.initializedOnly || current.meta.usableIndicatorCount === 0 ? 'unavailable'
    : coreNotUpdated ? 'stale' : absent.length || retained.length ? 'partial' : 'ok';
  const columns = {
    core: { status: coreStatus, requestedDate: current.meta.requestedDate, dataThrough: current.meta.dataThrough,
      fetchedAt: current.meta.generatedAt, notUpdated: coreNotUpdated, error: lastCore?.error ?? null,
      missing: absent.map((indicator) => ({ id: indicator.id, name: indicator.name, reason: indicator.error })),
      retained: retained.map((indicator) => ({ id: indicator.id, name: indicator.name, observationDate: indicator.observationDate, reason: indicator.error })),
      observations: indicators.map((indicator) => ({ id: indicator.id, observationDate: indicator.observationDate, status: indicator.status })),
      refreshAudit: current.meta.refreshAudit ?? null },
    rates: { status: !rates ? 'unavailable' : rateNotUpdated ? 'stale' : 'ok', requestedDate: rates?.requestedDate ?? null,
      dataThrough: rates?.spreadAsOf ?? null, fetchedAt: rates?.fetchedAt ?? null, notUpdated: rateNotUpdated,
      reason: lastRates?.error || (!rates ? 'Choice 尚未启用或未能取得中美利差数据' : rateNotUpdated ? '本轮未更新，保留原观察日期' : null) },
    fed: { status: fed.meta.status === 'unavailable' ? 'unavailable' : fedNotUpdated ? 'stale' : fed.meta.status,
      requestedDate: fed.meta.requestedDate, fetchedAt: fed.meta.generatedAt, notUpdated: fedNotUpdated,
      errors: [...(fed.meta.errors ?? []), ...(lastFed?.error ? [lastFed.error] : [])], warnings: fed.meta.warnings ?? [] },
    calendar: { status: fed.calendar?.status ?? 'unavailable', fetchedAt: fed.calendar?.fetchedAt ?? null,
      warnings: fed.calendar?.warnings ?? [], notUpdated: fedNotUpdated },
  };
  const complete = Object.values(columns).every((column) => column.status === 'ok');
  const notice = [
    `核心指标：${current.meta.usableIndicatorCount}/33项可用，${absent.length}项缺失，${retained.length}项本轮未更新。`,
    coreNotUpdated ? `核心栏目沿用检查日 ${current.meta.requestedDate} 的快照。` : '',
    rateNotUpdated ? `中美利差：${columns.rates.reason}。` : '',
    fed.meta.status !== 'ok' ? `议息概率：${columns.fed.status}。` : '',
    columns.calendar.status !== 'ok' ? `事件日历：${columns.calendar.status}。` : '',
    '议息概率与未来事件按本次读取时间采集。',
  ].filter(Boolean).join('');
  const ratesHtml = renderRateChart(rates, rateNotUpdated ? columns.rates.reason : null);
  const dashboard = shell.replace('<!--USD_RATE_CHART-->', ratesHtml);
  const builtAt = new Date().toISOString();
  const extraCss = `
    .page-head{padding:24px 0 14px;border-bottom:1px solid var(--ink);margin-bottom:16px}
    .page-head h1{font-size:28px;line-height:1.3;margin:0 0 6px}.page-head p{font-size:13px;color:var(--text);margin:4px 0}
    .publication-notice{padding:10px 14px;margin:12px 0 18px;border:1px solid var(--line);background:var(--panel);font-size:12px;color:var(--text)}
    .page-foot{padding:24px 0;font-size:12px;color:var(--muted)}
    .usl-nav-shell{top:12px;max-height:calc(100vh - 24px)}
    .us-rate-section>h3,.us-rate-section>p{margin:12px 16px}
    [hidden]{display:none!important}
    @media(max-width:700px){.container{width:calc(100% - 24px)}.page-head h1{font-size:23px}}
  `;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>美元流动性</title><style>${baseCss}\n${dashboardCss}\n${rateCss}\n${extraCss}</style></head><body><main class="container">
    <header class="page-head"><h1>美元流动性</h1><p>政策利率、金融条件、美元融资与财政供给</p>
      <p>检查日 ${escape(requestedDate)} · 各指标保留实际观察日期 · 时间采用北京时间</p></header>
    <aside class="publication-notice" aria-label="数据完整性">${escape(notice)}</aside>${dashboard}
    <footer class="page-foot">来源与统计口径见各指标说明。构建时间 ${escape(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(builtAt)))}，北京时间。</footer></main>
    <script id="usd-dashboard-data">globalThis.__US_LIQUIDITY_DASHBOARD__=${jsonForScript(compact)};
globalThis.__FED_EXPECTATIONS__=${jsonForScript(fed)};
globalThis.__treasuryContext=${treasuryContext.toString()};</script>
    <script>${fedJs}</script><script>${dashboardJs}</script><script>${rateJs}</script></body></html>\n`;
  const sourceContents = { 'data/us-liquidity/current.json': currentText, 'public/data/us-liquidity-current.js': webText,
    'data/fed-expectations/current.json': fedText, 'public/data/fed-expectations-current.js': fedWebText,
    ...(rates ? { 'data/rate-data/current.json': await read('data/rate-data/current.json') } : {}) };
  const publication = { schemaVersion: 1, requestedDate, builtAt, state: complete ? 'verified' : 'verified_partial',
    columns, files: Object.fromEntries(Object.entries(sourceContents).map(([file, content]) => [file, sha256(content)])), htmlSha256: sha256(html) };
  const publicationText = JSON.stringify(publication, null, 2) + '\n';
  await promote([
    { file: path.join(root, 'dist/index.html'), content: html },
    { file: path.join(root, 'dist/publication-status.json'), content: publicationText },
    { file: path.join(root, 'public/data/publication-status.json'), content: publicationText },
  ]);
  console.log(`网页已构建 ${path.join(root, 'dist/index.html')}，${publication.state}`);
  return publication;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('用法 node scripts/build.mjs');
  await buildDashboard(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
