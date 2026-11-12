import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith('--')) {
  console.error('用法 node scripts/create-dashboard.mjs <输出项目目录>');
  process.exit(2);
}
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或以上版本');
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.resolve(args[0]);
const template = path.join(skillRoot, 'assets/dashboard');
const relative = path.relative(template, destination);
if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
  throw new Error('输出目录必须位于 skill 模板之外');
}
try {
  const info = await fs.lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink() || (await fs.readdir(destination)).length) {
    throw new Error('输出目录已存在且不可初始化，请使用新的空目录');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await fs.mkdir(destination, { recursive: true });
for (const name of await fs.readdir(template)) {
  await fs.cp(path.join(template, name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true });
}
const result = spawnSync(process.execPath, [path.join(destination, 'scripts/initialize.mjs')], {
  cwd: destination, stdio: 'inherit', windowsHide: true,
});
if (result.error || result.status !== 0) throw new Error(`初始化失败，${result.error?.message ?? result.status}`);
console.log(`项目已生成 ${destination}`);
console.log(`网页 ${path.join(destination, 'dist/index.html')}`);
console.log('下一步在项目目录执行 node scripts/update.mjs，抓取实际数据。');
