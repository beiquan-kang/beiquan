import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolvePython } from "../lib/runtime.mjs";
import {
  CHOICE_RATE_SERIES_IDS,
  RATE_SERIES_KEYS,
  alignUsTreasuryCurve,
  buildCn10yCoverageWarnings,
  buildRateSnapshot,
  calendarDayDifference,
  mergeRateChunks,
  parseIsoDate,
  parseChoiceRatePayload,
} from "./lib/rate-snapshot.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const MAX_DATA_LAG_DAYS = 14;

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function addUtcDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addUtcYears(value, years) {
  const date = new Date(`${value}T00:00:00Z`);
  const targetYear = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function yearlyChunks(start, end) {
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const anniversary = addUtcYears(cursor, 1);
    const chunkEnd = anniversary >= end || chunks.length === 9
      ? end
      : addUtcDays(anniversary, -1);
    chunks.push({ start: cursor, end: chunkEnd });
    cursor = addUtcDays(chunkEnd, 1);
  }
  return chunks;
}

function assertYearlyChunkContract() {
  const sample = yearlyChunks("2016-08-24", "2026-08-24");
  if (sample.length !== 10
    || sample[0].start !== "2016-08-24"
    || sample.at(-1).end !== "2026-08-24") {
    throw new Error("十年利率窗口必须拆为十个年度分段");
  }
}

assertYearlyChunkContract();

const args = process.argv.slice(2);
if (args.length !== 1) fail("只接受一个 YYYY-MM-DD 日期参数", 2);
let requestedDate;
try {
  requestedDate = parseIsoDate(args[0], "输入日期");
} catch (error) {
  fail(error.message, 2);
}

const queryStart = addUtcYears(requestedDate, -10);
const chunks = yearlyChunks(queryStart, requestedDate);
if (chunks.length !== 10) fail(`十年利率窗口分段数错误 ${chunks.length}`);
const evidenceDirectory = path.join(repoRoot, "outputs", "rate-data", requestedDate, "choice-raw", String(Date.now()));
await fs.mkdir(evidenceDirectory, { recursive: true });
const requestPath = path.join(evidenceDirectory, "request.json");
const responsePath = path.join(evidenceDirectory, "response.json");
await fs.writeFile(requestPath, JSON.stringify({ indicators: Object.values(CHOICE_RATE_SERIES_IDS), chunks }, null, 2), "utf8");
const result = spawnSync(resolvePython(process.env),
  ["-X", "utf8", path.join(scriptDir, "choice-rates.py"), requestPath, responsePath],
  { cwd: repoRoot, env: process.env, stdio: "inherit", windowsHide: true, timeout: 1_800_000 });
if (result.error || result.status !== 0) fail(`Choice利率取数失败，原始记录 ${evidenceDirectory}`);
const response = JSON.parse(await fs.readFile(responsePath, "utf8"));
if (!Array.isArray(response.chunks) || response.chunks.length !== chunks.length) fail("Choice利率年度分段不完整");
const parsedChunks = response.chunks.map((record, index) => {
  if (record.start !== chunks[index].start || record.end !== chunks[index].end) fail("Choice利率分段日期不匹配");
  return parseChoiceRatePayload(record.result, {
  ...chunks[index],
  scope: `第${index + 1}个年度分段`,
  });
});
const mergedPointsBySeries = mergeRateChunks(parsedChunks);
const treasuryAlignment = alignUsTreasuryCurve(mergedPointsBySeries);
const pointsBySeries = treasuryAlignment.pointsBySeries;

const warnings = [
  ...treasuryAlignment.warnings,
  ...buildCn10yCoverageWarnings(pointsBySeries.cn10y, {
    windowStart: queryStart,
    windowEnd: requestedDate,
  }),
];
const snapshot = buildRateSnapshot({
  requestedDate,
  fetchedAt: new Date().toISOString(),
  pointsBySeries,
  warnings,
});
for (const field of ["curveAsOf", "spreadAsOf"]) {
  const lagDays = calendarDayDifference(requestedDate, snapshot[field]);
  if (lagDays > MAX_DATA_LAG_DAYS) fail(`${field}距输入日期超过${MAX_DATA_LAG_DAYS}天`);
}

const snapshotPath = path.join(repoRoot, "data", "rate-data", "snapshots", `${requestedDate}.json`);
const summary = {
  output: snapshotPath,
  dryRun: process.env.RATE_DATA_DRY_RUN === "1",
  requestedDate,
  queryStart,
  windowStart: snapshot.windowStart,
  curveAsOf: snapshot.curveAsOf,
  spreadAsOf: snapshot.spreadAsOf,
  chunkCount: chunks.length,
  evidenceDirectory,
  pointCounts: Object.fromEntries(RATE_SERIES_KEYS.map((key) => [key, snapshot.series[key].points.length])),
  spreadPointCount: snapshot.spread.points.length,
  warnings: snapshot.warnings,
};

if (process.env.RATE_DATA_DRY_RUN === "1") {
  await fs.writeFile(path.join(evidenceDirectory, "candidate-snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(evidenceDirectory, "validation-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
} else {
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(snapshotPath);
}
