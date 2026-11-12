import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSite } from './site-build.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const args = process.argv.slice(2);

if (args.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
  console.error('用法 node scripts/us-liquidity-data/refresh.mjs YYYY-MM-DD');
  process.exit(2);
}

const requestedDate = args[0];
const parsed = new Date(`${requestedDate}T00:00:00Z`);
if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== requestedDate) {
  console.error(`输入日期无效 ${requestedDate}`);
  process.exit(2);
}

function runExecutable(command, commandArgs, env, label) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`${label}启动失败，${result.error.message}`);
  if (result.signal) throw new Error(`${label}被信号${result.signal}终止`);
  if (result.status !== 0) throw new Error(`${label}失败，退出码${result.status ?? 1}`);
}

function runNodeScript(script, scriptArgs, env) {
  runExecutable(
    process.execPath,
    [path.join(scriptDir, script), ...scriptArgs],
    env,
    script,
  );
}

const candidatePrefix = 'us-liquidity-refresh-';
const temporaryRoot = path.join(repoRoot, 'outputs', 'us-liquidity', 'tmp');
await fs.mkdir(temporaryRoot, { recursive: true });
const candidateDirectory = await fs.mkdtemp(path.join(temporaryRoot, candidatePrefix));
const candidatePath = path.join(candidateDirectory, 'candidate.json');
const rollbackPath = path.join(candidateDirectory, 'rollback.json');
const currentPath = path.join(repoRoot, 'data', 'us-liquidity', 'current.json');
const startedAt = new Date().toISOString();
const runDirectory = path.join(repoRoot, 'outputs', 'us-liquidity',
  `${requestedDate}-${startedAt.replaceAll(/[:.]/g, '-')}-${process.pid}`);
const skipBuild = process.env.US_LIQUIDITY_SKIP_SITE_BUILD === '1';
let stage = 'fetch';
let runReport = { requestedDate, startedAt, siteBuildSkipped: skipBuild, state: 'running' };
const pipelineEnv = {
  ...process.env,
  USD_LIQUIDITY_RAW_DIR: path.join(runDirectory, 'source-raw'),
  US_LIQUIDITY_CANDIDATE_PATH: candidatePath,
};

try {
  const summaryBase = JSON.parse(await fs.readFile(currentPath, 'utf8'));
  runNodeScript('fetch-current.cjs', [requestedDate], pipelineEnv);
  stage = 'summary';
  runNodeScript('generate-summary.mjs', summaryBase.meta.usableIndicatorCount === 0
    ? [requestedDate, '--bootstrap-last-two'] : [requestedDate], pipelineEnv);
  stage = 'validation';
  runNodeScript('validate-current.mjs', [requestedDate], pipelineEnv);

  const previousCurrent = await fs.readFile(currentPath, 'utf8');
  const previousSnapshot = JSON.parse(previousCurrent);
  const previousRequestedDate = previousSnapshot?.meta?.requestedDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(previousRequestedDate || '')) {
    throw new Error('旧正式数据缺少有效输入日期，无法建立回滚点');
  }
  runNodeScript('validate-current.mjs', [previousRequestedDate], {
    ...pipelineEnv,
    US_LIQUIDITY_CANDIDATE_PATH: currentPath,
  });

  stage = 'publish';
  runNodeScript('publish-web-data.mjs', [requestedDate], pipelineEnv);

  try {
    stage = 'build';
    if (!skipBuild) await buildSite(repoRoot);
  } catch (buildError) {
    await fs.writeFile(rollbackPath, previousCurrent, 'utf8');
    try {
      runNodeScript('publish-web-data.mjs', [previousRequestedDate], {
        ...pipelineEnv,
        US_LIQUIDITY_CANDIDATE_PATH: rollbackPath,
      });
    } catch (rollbackError) {
      throw new Error(`${buildError.message}；构建失败后的正式数据恢复也失败，${rollbackError.message}`);
    }
    throw new Error(`${buildError.message}；正式数据已恢复到${previousRequestedDate}`);
  }

  const snapshot = JSON.parse(await fs.readFile(currentPath, 'utf8'));
  runReport = { ...runReport, state: skipBuild ? 'data-published-awaiting-build' : 'published',
    finishedAt: new Date().toISOString(), sourceMeta: snapshot.meta };
  console.log(`美元流动性${skipBuild ? '数据更新完成，等待统一构建' : '更新完成'}  日期 ${requestedDate}`);
} catch (error) {
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.copyFile(candidatePath, path.join(runDirectory, 'failed-candidate.json')).catch((copyError) => {
    if (copyError.code !== 'ENOENT') console.error(`失败候选归档失败 ${copyError.message}`);
  });
  runReport = { ...runReport, state: 'failed', failedStage: stage,
    finishedAt: new Date().toISOString(), error: error.message };
  throw error;
} finally {
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(path.join(runDirectory, 'run-report.json'), `${JSON.stringify(runReport, null, 2)}\n`, 'utf8');
  console.log(`刷新证据 ${runDirectory}`);
  const resolvedDirectory = path.resolve(candidateDirectory);
  const safeDirectory = path.dirname(resolvedDirectory).toLowerCase() === temporaryRoot.toLowerCase()
    && path.basename(resolvedDirectory).startsWith(candidatePrefix);
  if (!safeDirectory) throw new Error(`拒绝清理未验证的候选目录 ${resolvedDirectory}`);
  await fs.rm(resolvedDirectory, { recursive: true, force: true });
}
