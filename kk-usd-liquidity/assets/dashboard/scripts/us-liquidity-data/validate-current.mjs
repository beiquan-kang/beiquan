import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUsLiquiditySnapshot } from './lib/snapshot.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const inputPath = path.resolve(
  process.env.US_LIQUIDITY_CANDIDATE_PATH
    || path.join(repoRoot, 'data', 'us-liquidity', 'candidate.json'),
);
const args = process.argv.slice(2);

if (args.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
  throw new Error('用法 node validate-current.mjs YYYY-MM-DD');
}

const expectedRequestedDate = args[0];
const parsed = new Date(`${expectedRequestedDate}T00:00:00Z`);
if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expectedRequestedDate) {
  throw new Error(`验收日期无效 ${expectedRequestedDate}`);
}

const snapshot = JSON.parse(await fs.readFile(inputPath, 'utf8'));
validateUsLiquiditySnapshot(snapshot, { expectedRequestedDate, requireDailySummary: true });
const uniqueIndicators = new Set(
  snapshot.modules.flatMap((module) => module.indicators.map((indicator) => indicator.id)),
);
const historyCount = [...uniqueIndicators].reduce((total, id) => {
  const indicator = snapshot.modules
    .flatMap((module) => module.indicators)
    .find((item) => item.id === id);
  return total + indicator.history.length;
}, 0);
console.log(`美元流动性候选数据验收通过  模块 ${snapshot.modules.length}  唯一指标 ${uniqueIndicators.size}  历史观察 ${historyCount}`);
console.log(`日度摘要验收通过  状态 ${snapshot.dailySummary.state}  入选变化 ${snapshot.dailySummary.selectedChangeCount}`);
console.log(`候选文件 ${inputPath}`);
