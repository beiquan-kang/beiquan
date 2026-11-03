import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const queue = [];
let active = 0;
const processOptions = (options) => ({
  env: process.env, encoding: 'utf8', timeout: 30000,
  maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal: options.signal,
});
const windowsRead = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $request = @{ Uri = $env:USD_LIQUIDITY_REQUEST_URL; UseBasicParsing = $true; TimeoutSec = 25; Headers = @{ 'User-Agent' = 'UsdLiquidityDashboard/1.0'; 'Accept' = '*/*' } }
  $proxyUrl = $env:HTTPS_PROXY
  if (-not $proxyUrl) { $proxyUrl = $env:ALL_PROXY }
  if ($proxyUrl -match '^https?://') { $request.Proxy = $proxyUrl }
  $response = Invoke-WebRequest @request
  [Console]::Write($response.Content)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;

export async function publicFetch(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('公开数据接口必须使用 HTTPS');
  if (options.method && options.method.toUpperCase() !== 'GET') throw new Error('数据接口仅支持 GET');
  if (active >= 6) await new Promise((resolve) => queue.push(resolve));
  else active += 1;
  try {
    if (process.platform !== 'win32' || process.env.USD_LIQUIDITY_HTTP_MODE === 'node') {
      const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(28000) });
      return new Response(await response.text(), { status: response.status, headers: response.headers });
    }
    if (process.env.USD_LIQUIDITY_HTTP_MODE !== 'powershell') {
      try {
        const { stdout } = await execute('curl.exe', [
          '--fail', '--location', '--max-time', '28', '--connect-timeout', '10', '--silent', '--show-error', String(url),
        ], processOptions(options));
        return new Response(stdout, { status: 200 });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const { stdout } = await execute('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsRead, 'utf16le').toString('base64'),
    ], {
      ...processOptions(options),
      env: { ...process.env, USD_LIQUIDITY_REQUEST_URL: String(url) },
    });
    return new Response(stdout, { status: 200 });
  } catch (error) {
    throw new Error(`公开接口读取失败 ${parsed.hostname}，${error.stderr?.trim() || error.cause?.message || error.message}`);
  } finally {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  }
}
