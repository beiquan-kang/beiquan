import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compactUsLiquiditySnapshot,
  validateUsLiquiditySnapshot,
} from './lib/snapshot.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const candidatePath = path.resolve(
  process.env.US_LIQUIDITY_CANDIDATE_PATH
    || path.join(repoRoot, 'data', 'us-liquidity', 'candidate.json'),
);
const currentPath = path.join(repoRoot, 'data', 'us-liquidity', 'current.json');
const outputPath = path.join(repoRoot, 'public', 'data', 'us-liquidity-current.js');
const args = process.argv.slice(2);

if (args.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
  throw new Error('用法 node publish-web-data.mjs YYYY-MM-DD');
}

const expectedRequestedDate = args[0];
const parsed = new Date(`${expectedRequestedDate}T00:00:00Z`);
if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expectedRequestedDate) {
  throw new Error(`发布日期无效 ${expectedRequestedDate}`);
}

if (candidatePath.toLowerCase() === currentPath.toLowerCase()) {
  throw new Error('候选文件不能直接指向正式数据文件');
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function publishAtomically(entries) {
  const token = `${process.pid}-${Date.now()}`;
  const transaction = entries.map((entry) => ({
    ...entry,
    temporaryPath: `${entry.targetPath}.tmp-${token}`,
    backupPath: `${entry.targetPath}.bak-${token}`,
    backedUp: false,
    promoted: false,
  }));

  for (const entry of transaction) {
    await fs.mkdir(path.dirname(entry.targetPath), { recursive: true });
    await fs.writeFile(entry.temporaryPath, entry.content, 'utf8');
  }

  try {
    for (const entry of transaction) {
      if (await exists(entry.targetPath)) {
        await fs.rename(entry.targetPath, entry.backupPath);
        entry.backedUp = true;
      }
    }

    for (const entry of transaction) {
      await fs.rename(entry.temporaryPath, entry.targetPath);
      entry.promoted = true;
    }

    const publishedSnapshot = JSON.parse(await fs.readFile(currentPath, 'utf8'));
    validateUsLiquiditySnapshot(publishedSnapshot, { expectedRequestedDate, requireDailySummary: true });
    const publishedScript = await fs.readFile(outputPath, 'utf8');
    if (publishedScript !== entries.find((entry) => entry.targetPath === outputPath).content) {
      throw new Error('网页数据发布后内容校验不一致');
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of [...transaction].reverse()) {
      try {
        if (entry.promoted) await removeIfExists(entry.targetPath);
        if (entry.backedUp) await fs.rename(entry.backupPath, entry.targetPath);
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.targetPath}恢复失败，${rollbackError.message}`);
      }
      try {
        await removeIfExists(entry.temporaryPath);
      } catch (cleanupError) {
        rollbackErrors.push(`${entry.temporaryPath}清理失败，${cleanupError.message}`);
      }
    }
    const detail = rollbackErrors.length ? `；${rollbackErrors.join('；')}` : '';
    throw new Error(`美元流动性事务发布失败，正式数据已回滚，${error.message}${detail}`);
  }

  for (const entry of transaction) {
    try {
      await removeIfExists(entry.backupPath);
    } catch (error) {
      console.warn(`发布备份清理失败 ${entry.backupPath}  ${error.message}`);
    }
  }
}

const snapshot = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
validateUsLiquiditySnapshot(snapshot, { expectedRequestedDate, requireDailySummary: true });
const compact = compactUsLiquiditySnapshot(snapshot);
const currentJson = `${JSON.stringify(snapshot, null, 2)}\n`;
const webScript = `globalThis.__US_LIQUIDITY_DASHBOARD__=${safeJson(compact)};\n`;

if (process.env.US_LIQUIDITY_PUBLISH_DRY_RUN === '1') {
  console.log(`美元流动性候选发布预检通过  日期 ${expectedRequestedDate}`);
  console.log(`候选文件 ${candidatePath}`);
} else {
  await publishAtomically([
    { targetPath: currentPath, content: currentJson },
    { targetPath: outputPath, content: webScript },
  ]);
  console.log(`美元流动性事务发布完成  日期 ${expectedRequestedDate}`);
  console.log(`正式数据 ${currentPath}`);
  console.log(`网页数据 ${outputPath}`);
}
