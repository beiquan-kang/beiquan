import { buildDashboard } from '../build.mjs';

export async function buildSite(repoRoot) {
  await buildDashboard(repoRoot);
}
