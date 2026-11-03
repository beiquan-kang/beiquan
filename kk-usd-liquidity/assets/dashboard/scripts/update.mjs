import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseDate, todayShanghai, runNode } from './lib/runtime.mjs';
import { initialize } from './initialize.mjs';
import { buildDashboard } from './build.mjs';
import { verifyPublished } from './verify.mjs';
import { validateRateSnapshot } from './rate-data/lib/rate-snapshot.mjs';

const args = process.argv.slice(2);
if (args.length > 1) throw new Error('用法 node scripts/update.mjs [YYYY-MM-DD]');
const requestedDate = parseDate(args[0] ?? todayShanghai());
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(root, '.update.lock');
let lock;
try { lock = await fs.open(lockPath, 'wx'); }
catch (error) {
  if (error.code === 'EEXIST') throw new Error('已有更新锁，请核实其他更新进程是否仍在运行');
  throw error;
}

const startedAt = new Date().toISOString();
const runDirectory = path.join(root, 'outputs/update', `${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
const formalFiles = [
  'data/us-liquidity/current.json', 'public/data/us-liquidity-current.js',
  'data/fed-expectations/current.json', 'public/data/fed-expectations-current.js',
  'data/rate-data/current.json', 'data/update-state.json',
  'dist/index.html', 'dist/publication-status.json', 'public/data/publication-status.json',
];
const backups = new Map();
const report = { schemaVersion: 1, requestedDate, startedAt, state: 'running', columns: {} };

async function restore(files) {
  const failures = [];
  for (const relative of files) {
    try {
      const old = backups.get(relative);
      if (old === null) await fs.rm(path.join(root, relative), { force: true });
      else if (old !== undefined) {
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fs.writeFile(path.join(root, relative), old);
      }
    } catch (error) { failures.push(`${relative} ${error.message}`); }
  }
  if (failures.length) throw new Error(`正式文件恢复失败，备份位于 ${runDirectory}；${failures.join('；')}`);
}

try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, requestedDate, startedAt }));
  try { await fs.access(path.join(root, 'data/us-liquidity/current.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await initialize(root); }
  const previous = JSON.parse(await fs.readFile(path.join(root, 'data/us-liquidity/current.json'), 'utf8'));
  if (!previous.meta.initializedOnly && previous.meta.requestedDate > requestedDate) {
    throw new Error('输入日期早于已发布检查日；历史截面请使用独立项目目录');
  }
  await fs.mkdir(runDirectory, { recursive: true });
  for (const relative of formalFiles) {
    let body;
    try { body = await fs.readFile(path.join(root, relative)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; body = null; }
    backups.set(relative, body);
    if (body !== null) {
      const backup = path.join(runDirectory, 'backup', relative);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.writeFile(backup, body);
    }
  }
  const environment = { ...process.env, US_LIQUIDITY_SKIP_SITE_BUILD: '1', FED_EXPECTATIONS_SKIP_SITE_BUILD: '1' };
  // The inherited candidate path is deliberately cleared for a project-level refresh.
  delete environment.US_LIQUIDITY_CANDIDATE_PATH;
  delete environment.US_LIQUIDITY_BASE_PATH;
  delete environment.US_LIQUIDITY_PUBLISH_DRY_RUN;
  delete environment.RATE_DATA_DRY_RUN;
  const core = ['data/us-liquidity/current.json', 'public/data/us-liquidity-current.js'];
  try {
    runNode(root, 'scripts/us-liquidity-data/refresh.mjs', [requestedDate], environment);
    report.columns.core = { state: 'updated' };
  } catch (error) {
    await restore(core);
    report.columns.core = { state: 'failed', error: error.message };
    console.warn(`美元流动性本轮未更新，${error.message}`);
  }

  if (environment.USD_LIQUIDITY_USE_CHOICE !== '1') {
    report.columns.rates = { state: 'skipped', error: 'Choice 尚未启用，中美利差本轮未更新' };
  } else {
    try {
      runNode(root, 'scripts/rate-data/fetch-snapshot.mjs', [requestedDate], environment);
      const source = path.join(root, 'data/rate-data/snapshots', `${requestedDate}.json`);
      const content = await fs.readFile(source, 'utf8');
      validateRateSnapshot(JSON.parse(content), { expectedRequestedDate: requestedDate });
      const destination = path.join(root, 'data/rate-data/current.json');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.tmp-${process.pid}`;
      await fs.writeFile(temporary, content);
      await fs.rename(temporary, destination);
      report.columns.rates = { state: 'updated' };
    } catch (error) {
      await restore(['data/rate-data/current.json']);
      report.columns.rates = { state: 'failed', error: error.message };
      console.warn(`中美利差本轮未更新，${error.message}`);
    }
  }
  try {
    runNode(root, 'scripts/fed-expectations/refresh.mjs', [requestedDate], environment);
    report.columns.fed = { state: 'updated' };
  } catch (error) {
    await restore(['data/fed-expectations/current.json', 'public/data/fed-expectations-current.js']);
    report.columns.fed = { state: 'failed', error: error.message };
    console.warn(`议息概率与日历本轮未更新，${error.message}`);
  }
  await fs.writeFile(path.join(root, 'data/update-state.json'), JSON.stringify(report, null, 2) + '\n');
  const publication = await buildDashboard(root);
  await verifyPublished(root);
  report.state = publication.state === 'verified' ? 'published' : 'published_partial';
  report.finishedAt = new Date().toISOString();
  report.publication = publication;
  console.log(`更新完成 ${requestedDate}，${publication.state}`);
  console.log(`核心指标缺失 ${publication.columns.core.missing.length} 项，本轮未更新 ${publication.columns.core.retained.length} 项`);
  console.log(`中美利差 ${publication.columns.rates.status}，议息概率 ${publication.columns.fed.status}，事件日历 ${publication.columns.calendar.status}`);
} catch (error) {
  await restore(formalFiles);
  report.state = 'failed'; report.finishedAt = new Date().toISOString(); report.error = error.message;
  console.error(`更新失败，正式文件已恢复，${error.message}`);
  process.exitCode = 1;
} finally {
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(path.join(runDirectory, 'run-report.json'), JSON.stringify(report, null, 2) + '\n');
  await lock.close();
  await fs.unlink(lockPath);
  console.log(`运行记录 ${runDirectory}`);
}
