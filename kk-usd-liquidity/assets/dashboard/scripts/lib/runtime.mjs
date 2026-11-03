import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function todayShanghai(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function parseDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || !Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 10) !== value) throw new Error('日期必须是有效 YYYY-MM-DD');
  if (value > todayShanghai()) throw new Error('输入日期晚于北京时间今天');
  return value;
}

export function resolvePython(environment = process.env) {
  return environment.USD_LIQUIDITY_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
}

export function runNode(root, script, args = [], environment = process.env) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root, env: environment, stdio: 'inherit', shell: false, windowsHide: true,
    timeout: 30 * 60 * 1000,
  });
  if (result.error) throw new Error(`${script} 启动失败，${result.error.message}`);
  if (result.status !== 0) throw new Error(`${script} 执行失败，退出码 ${result.status ?? result.signal}`);
}

export async function readOptionalJson(file, fs) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
