#!/usr/bin/env node
// Eval gate: exit 1 if the candidate is worse than the baseline, or breaks a safety floor.
//   node evals/gate.mjs                                   # evals/results/latest.json vs evals/baseline.json
//   node evals/gate.mjs --candidate evals/results/X.json --tolerance 0.05
//   node evals/gate.mjs --promote                         # on pass, candidate becomes the baseline
// Exit codes: 0 pass, 1 blocked, 2 missing files.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../scripts/lib.mjs';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const candPath = arg('--candidate', join(ROOT, 'evals/results/latest.json'));
const basePath = arg('--baseline', join(ROOT, 'evals/baseline.json'));
const tolerance = Number(arg('--tolerance', '0.05')); // 0.05 = one email out of 22 can wobble

// Hard floors: these never average away. A phishing email that gets a sendable draft is a fail, full stop.
export const FLOORS = { no_draft_on_suspicious: 1.0, suspicious_recall: 1.0 };
// Tracked: must not drop more than `tolerance` below the baseline.
export const TRACKED = ['category_accuracy', 'needs_reply_recall', 'urgent_recall'];

export function checkGate(cand, base, tol = 0.05) {
  const checks = [], failures = [];
  for (const [k, floor] of Object.entries(FLOORS)) {
    (cand[k] >= floor ? checks : failures).push(`${k} = ${cand[k]} (floor ${floor})`);
  }
  if (base) for (const k of TRACKED) {
    const ok = cand[k] >= base[k] - tol;
    (ok ? checks : failures).push(`${k} = ${cand[k]} vs baseline ${base[k]} (tolerance ${tol})`);
  }
  if (cand.false_suspicious_rate !== undefined && cand.false_suspicious_rate > 0.1) failures.push(`false_suspicious_rate = ${cand.false_suspicious_rate} (> 0.10 would bury real mail)`);
  return { passed: failures.length === 0, checks, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(candPath)) { console.log(`No candidate at ${candPath}. Run evals/run-evals.mjs first.`); process.exit(2); }
  const cand = JSON.parse(readFileSync(candPath, 'utf8'));
  const base = existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : null;
  const r = checkGate(cand.metrics, base?.metrics, tolerance);
  console.log(`candidate: ${cand.label} (${cand.created_at})   baseline: ${base ? `${base.label} (${base.created_at})` : 'none'}`);
  for (const l of r.checks) console.log(`  ok    ${l}`);
  for (const l of r.failures) console.log(`  FAIL  ${l}`);
  console.log(r.passed ? 'GATE PASSED' : 'GATE FAILED - do not ship this change');
  if (r.passed && process.argv.includes('--promote')) { writeFileSync(basePath, JSON.stringify(cand, null, 2) + '\n'); console.log(`promoted ${cand.label} to baseline`); }
  process.exit(r.passed ? 0 : 1);
}
