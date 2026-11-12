import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { sha256, parseAssignment } from './build.mjs';
import { validateUsLiquiditySnapshot, compactUsLiquiditySnapshot } from './us-liquidity-data/lib/snapshot.mjs';
import { validatePayload } from './fed-expectations/model.mjs';
import { validateRateSnapshot } from './rate-data/lib/rate-snapshot.mjs';

export async function verifyPublished(root) {
  const read = (relative) => fs.readFile(path.join(root, relative), 'utf8');
  const [current, currentScript, fed, fedScript, publicationText, mirror, html] = await Promise.all([
    read('data/us-liquidity/current.json').then(JSON.parse), read('public/data/us-liquidity-current.js'),
    read('data/fed-expectations/current.json').then(JSON.parse), read('public/data/fed-expectations-current.js'),
    read('public/data/publication-status.json'), read('dist/publication-status.json'), read('dist/index.html'),
  ]);
  validateUsLiquiditySnapshot(current, { requireDailySummary: true });
  validatePayload(fed);
  const compact = compactUsLiquiditySnapshot(current);
  assert.deepEqual(parseAssignment(currentScript), compact, '美元流动性正式数据与网页数据不一致');
  assert.deepEqual(parseAssignment(fedScript), fed, '议息概率正式数据与网页数据不一致');
  assert.equal(publicationText, mirror, '发布状态镜像不一致');
  const publication = JSON.parse(publicationText);
  assert.equal(publication.htmlSha256, sha256(html), 'HTML 哈希不一致');
  assert(['verified', 'verified_partial'].includes(publication.state), '发布状态无效');
  for (const [relative, expected] of Object.entries(publication.files)) {
    const absolute = path.resolve(root, relative);
    const rel = path.relative(root, absolute);
    assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), '发布清单路径超出项目');
    assert.equal(sha256(await fs.readFile(absolute)), expected, `${relative} 哈希不一致`);
  }
  const embeddedCore = html.match(/globalThis\.__US_LIQUIDITY_DASHBOARD__=(.*?)\n/);
  const embeddedFed = html.match(/globalThis\.__FED_EXPECTATIONS__=(.*?)\n/);
  assert(embeddedCore && embeddedFed, '网页缺少完整嵌入数据');
  assert.deepEqual(JSON.parse(embeddedCore[1].replace(/;\s*$/, '')), compact, 'HTML 的美元流动性数据不一致');
  assert.deepEqual(JSON.parse(embeddedFed[1].replace(/;\s*$/, '')), fed, 'HTML 的议息数据不一致');
  assert(!/<script\b[^>]*\bsrc\s*=/i.test(html), '离线网页仍依赖外部脚本');
  assert(!/<link\b[^>]*rel=["']stylesheet/i.test(html), '离线网页仍依赖外部样式');
  if (publication.files['data/rate-data/current.json']) {
    validateRateSnapshot(JSON.parse(await read('data/rate-data/current.json')));
  }
  console.log(`只读验收通过 ${publication.requestedDate}，${publication.state}`);
  return publication;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('用法 node scripts/verify.mjs');
  await verifyPublished(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
