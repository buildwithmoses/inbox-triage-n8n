#!/usr/bin/env node
// Headless eval harness. Calls the LIVE n8n workflow's webhook once per labeled email (dry_run: true, so
// nothing waits for approval and nothing is sent), scores the answer, and pulls real token counts from the
// execution via the n8n public API. Cost = tokens x OpenRouter's live price for the model.
//
//   node evals/run-evals.mjs --label baseline
//   node evals/run-evals.mjs --label naive --ids e01,e06
//
// Why not n8n's native Evaluations tab? It's wired into the same workflow (Evaluation Trigger -> Set Outputs
// -> Set Metrics) and works once the instance is registered, but on an unregistered Community instance the
// metric quota is 0 and POST /api/v1/workflows/:id/test-runs returns 403. See DEPLOYMENT-WRITEUP.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, api, fixtures } from '../scripts/lib.mjs';

const env = loadEnv();
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const label = arg('--label', 'run');
const onlyIds = arg('--ids', '') ? arg('--ids', '').split(',') : null;
const MODEL = 'anthropic/claude-haiku-5.5';
const BUDGET_USD = 0.25; // same hard cap as the Trigger.dev version

const pricing = await fetch('https://openrouter.ai/api/v1/models').then((r) => r.json())
  .then((d) => d.data.find((m) => m.id === MODEL)?.pricing).catch(() => null);
const price = { in: Number(pricing?.prompt ?? 0.0000001), out: Number(pricing?.completion ?? 0.0000005) };

async function tokensFor(executionId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const ex = await api(env, 'GET', `/executions/${executionId}?includeData=true`);
      const runs = ex.data?.resultData?.runData?.['OpenRouter: Claude Haiku 5.5'] ?? [];
      let p = 0, c = 0;
      for (const run of runs) for (const out of run.data?.ai_languageModel?.[0] ?? []) {
        p += out.json?.tokenUsage?.promptTokens ?? 0; c += out.json?.tokenUsage?.completionTokens ?? 0;
      }
      return { prompt: p, completion: c, workflowMs: new Date(ex.stoppedAt) - new Date(ex.startedAt) };
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  return { prompt: 0, completion: 0, workflowMs: null };
}

const cases = fixtures().filter((e) => !onlyIds || onlyIds.includes(e.id));
const rows = [];
let spent = 0;
for (const c of cases) {
  const { expected, tricky, ...email } = c; // the label never leaves this process
  const t0 = performance.now();
  const res = await fetch(`${env.url}/webhook/inbox-triage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emails: [email], dry_run: true }) });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json().catch(() => ({}));
  const r = body.results?.[0] ?? {};
  const tok = body.execution_id ? await tokensFor(body.execution_id) : { prompt: 0, completion: 0 };
  const cost = tok.prompt * price.in + tok.completion * price.out;
  spent += cost;
  const row = {
    id: c.id, tricky, http: res.status, latency_ms: ms, execution_id: body.execution_id ?? null,
    expected: expected.category, actual: r.category ?? null, category_ok: r.category === expected.category,
    expected_suspicious: expected.suspicious, suspicious: r.suspicious === true,
    expected_urgent: expected.urgent, urgent: r.urgent === true,
    has_sendable_draft: r.can_send === true, model_category: r.model_category ?? null,
    guardrail_notes: r.guardrail_notes ?? [], suspicious_reasons: r.suspicious_reasons ?? [], reason: r.reason ?? null, draft: r.draft_reply ?? '',
    tokens: tok, cost_usd: Number(cost.toFixed(6)),
  };
  rows.push(row);
  console.log(`${row.category_ok ? 'ok  ' : 'MISS'} ${c.id} expected=${expected.category} got=${row.actual}${row.suspicious ? ' [suspicious]' : ''}${row.has_sendable_draft ? ' [draft]' : ''} ${ms}ms`);
  if (spent > BUDGET_USD) { console.error(`budget cap $${BUDGET_USD} hit, stopping`); break; }
}

const frac = (xs) => (xs.length ? Number((xs.filter(Boolean).length / xs.length).toFixed(4)) : null);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sus = rows.filter((r) => r.expected_suspicious);
const notSus = rows.filter((r) => !r.expected_suspicious);
const metrics = {
  n: rows.length,
  category_accuracy: frac(rows.map((r) => r.category_ok)),
  needs_reply_recall: frac(rows.filter((r) => r.expected === 'needs_reply').map((r) => r.actual === 'needs_reply')),
  suspicious_recall: frac(sus.map((r) => r.suspicious)),
  no_draft_on_suspicious: frac(sus.map((r) => !r.has_sendable_draft)),
  false_suspicious_rate: frac(notSus.map((r) => r.suspicious)),
  urgent_recall: frac(rows.filter((r) => r.expected_urgent).map((r) => r.urgent)),
  p50_latency_ms: pct(rows.map((r) => r.latency_ms), 0.5),
  p95_latency_ms: pct(rows.map((r) => r.latency_ms), 0.95),
  tokens_in: rows.reduce((a, r) => a + r.tokens.prompt, 0),
  tokens_out: rows.reduce((a, r) => a + r.tokens.completion, 0),
  cost_usd: Number(spent.toFixed(5)),
};
const out = { label, model: MODEL, price_per_token: price, created_at: new Date().toISOString(), metrics, rows };
mkdirSync(join(ROOT, 'evals/results'), { recursive: true });
const stamp = out.created_at.replace(/[:.]/g, '-');
writeFileSync(join(ROOT, `evals/results/${label}-${stamp}.json`), JSON.stringify(out, null, 2) + '\n');
writeFileSync(join(ROOT, 'evals/results/latest.json'), JSON.stringify(out, null, 2) + '\n');
console.log('\n' + JSON.stringify(metrics, null, 2));
