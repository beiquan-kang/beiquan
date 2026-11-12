import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { todayShanghai, runNode } from './lib/runtime.mjs';
import { buildDashboard } from './build.mjs';
import { HISTORY_METHOD } from './fed-expectations/model.mjs';

export async function initialize(root) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或以上版本');
  const date = todayShanghai();
  const generatedAt = new Date().toISOString();
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'data/us-liquidity/indicator-catalog.json'), 'utf8'));
  const currentPath = path.join(root, 'data/us-liquidity/current.json');
  let currentExists = false;
  try { await fs.access(currentPath); currentExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!currentExists) {
    const indicators = Object.fromEntries(Object.values(catalog.indicators).map((config) => [config.id, {
      id: config.id, name: config.name, shortName: config.shortName ?? null,
      unit: config.unit, displayDigits: config.displayDigits ?? null, direction: config.direction,
      definition: config.definition, formula: config.formula, frequency: config.frequency,
      sourceName: config.sourceName, sourceUrl: config.sourceUrl, seriesId: config.seriesId,
      ...(config.sourceSeriesId ? { sourceSeriesId: config.sourceSeriesId } : {}),
      limitation: config.limitations, availability: config.availability,
      value: null, change: null, changeLabel: config.changeLabel ?? null, changeUnit: config.changeUnit || config.unit,
      status: 'missing', updatedAt: null, observationDate: null, dataAgeDays: null,
      retainedPreviousValue: false, testFlag: null, error: '尚未执行数据抓取',
      history: [], historyStart: null, historyEnd: null, historyCount: 0,
    }]));
    const snapshot = {
      meta: { schemaVersion: catalog.schemaVersion, requestedDate: date, generatedAt, timezone: 'Asia/Shanghai',
        status: 'error', dataThrough: null, sourceSuccessCount: 0, sourceFailureCount: 0,
        usableIndicatorCount: 0, staleIndicatorCount: 0, missingIndicatorCount: Object.keys(indicators).length,
        retainedPreviousValues: [], errors: [], initializedOnly: true, note: '项目已初始化，等待首次抓取实际数据。' },
      modules: catalog.modules.map((module) => ({ id: module.id, title: module.title, summary: module.summary,
        status: 'missing', primaryIndicatorId: module.primaryIndicatorId,
        indicators: module.indicatorIds.map((id) => indicators[id]) })),
    };
    const temporary = path.join(root, 'outputs/initialize');
    await fs.mkdir(temporary, { recursive: true });
    const candidate = path.join(temporary, 'candidate.json');
    await fs.writeFile(candidate, JSON.stringify(snapshot, null, 2) + '\n');
    const environment = { ...process.env, US_LIQUIDITY_CANDIDATE_PATH: candidate };
    runNode(root, 'scripts/us-liquidity-data/generate-summary.mjs', [date, '--bootstrap-last-two'], environment);
    runNode(root, 'scripts/us-liquidity-data/publish-web-data.mjs', [date], environment);
    await fs.unlink(candidate);
  }
  const fedPath = path.join(root, 'data/fed-expectations/current.json');
  try { await fs.access(fedPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fed = { meta: { schemaVersion: '1.0.0', requestedDate: date, generatedAt,
      timezone: 'Asia/Shanghai', status: 'unavailable', initializedOnly: true,
      probabilityUnit: 'percent', quoteUnit: 'USD_per_share', historyMethod: HISTORY_METHOD,
      sourceName: 'Polymarket', sourceUrl: 'https://polymarket.com',
      changeMethod: '同一事件、代币和报价口径的本地快照差', errors: ['尚未执行数据抓取'], warnings: [] },
      meeting: null, outcomes: [], hikeProbability: null, switchedFromEventId: null,
      calendar: { fetchedAt: generatedAt, status: 'unavailable', events: [], warnings: ['尚未执行日历抓取'] } };
    await fs.mkdir(path.dirname(fedPath), { recursive: true });
    await fs.writeFile(fedPath, JSON.stringify(fed, null, 2) + '\n');
    await fs.mkdir(path.join(root, 'public/data'), { recursive: true });
    await fs.writeFile(path.join(root, 'public/data/fed-expectations-current.js'),
      `globalThis.__FED_EXPECTATIONS__=${JSON.stringify(fed).replaceAll('<', '\\u003c')};\n`);
  }
  await buildDashboard(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('用法 node scripts/initialize.mjs');
  await initialize(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
