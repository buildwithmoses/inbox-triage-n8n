#!/usr/bin/env node
// One-shot setup against a running n8n (public REST API). Idempotent: re-run any time.
//   1. credentials: OpenRouter (key from .env, never printed) + header-auth secret for the approval webhook
//   2. data tables: triage_eval_dataset (seeded with the 22 labeled fixtures) + triage_outbox (simulated sends)
//   3. builds the workflow from source, creates or updates it, and activates it (webhook goes live)
//
//   node scripts/setup.mjs                    # baseline
//   node scripts/setup.mjs --variant naive    # swap in the regression variant (same workflow id)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, api, readLocal, writeLocal, fixtures } from './lib.mjs';

const env = loadEnv();
if (!env.apiKey) throw new Error('Set N8N_API_KEY in .env (n8n Settings -> n8n API -> Create an API key).');
const variant = process.argv.includes('--variant') ? process.argv[process.argv.indexOf('--variant') + 1] : 'baseline';
const state = readLocal();

async function ensureCredential(key, body) {
  if (state[key]) return state[key];
  const c = await api(env, 'POST', '/credentials', body);
  state[key] = c.id; writeLocal(state);
  console.log(`created credential "${body.name}" (${c.id})`);
  return c.id;
}

async function ensureTable(key, name, columns) {
  if (state[key]) return state[key];
  const list = await api(env, 'GET', `/data-tables?filter=${encodeURIComponent(JSON.stringify({ name }))}`);
  const found = (list.data ?? []).find((t) => t.name === name);
  const t = found ?? (await api(env, 'POST', '/data-tables', { name, columns }));
  state[key] = t.id; writeLocal(state);
  console.log(`${found ? 'found' : 'created'} data table ${name} (${t.id})`);
  return t.id;
}

if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing from .env');
await ensureCredential('openRouterCredId', { name: 'OpenRouter (env)', type: 'openRouterApi', data: { apiKey: process.env.OPENROUTER_API_KEY } });
if (!env.approvalToken) throw new Error('APPROVAL_TOKEN missing from .env (openssl rand -hex 24)');
await ensureCredential('approvalCredId', { name: 'Approval header (local)', type: 'httpHeaderAuth', data: { name: 'X-Approval-Token', value: env.approvalToken } });

const evalTableId = await ensureTable('evalTableId', 'triage_eval_dataset', [
  { name: 'email_id', type: 'string' }, { name: 'from', type: 'string' }, { name: 'to', type: 'string' },
  { name: 'subject', type: 'string' }, { name: 'body', type: 'string' }, { name: 'received_at', type: 'string' },
  { name: 'expected_category', type: 'string' }, { name: 'expected_suspicious', type: 'boolean' }, { name: 'expected_urgent', type: 'boolean' },
  { name: 'actual_category', type: 'string' }, { name: 'actual_suspicious', type: 'string' }, { name: 'has_draft', type: 'string' }, { name: 'actual_reason', type: 'string' },
]);
await ensureTable('outboxTableId', 'triage_outbox', [
  { name: 'email_id', type: 'string' }, { name: 'to', type: 'string' }, { name: 'subject', type: 'string' }, { name: 'body', type: 'string' },
  { name: 'approved_by', type: 'string' }, { name: 'via', type: 'string' }, { name: 'edited', type: 'boolean' }, { name: 'sent_at', type: 'string' },
  { name: 'thread_id', type: 'string' }, { name: 'source', type: 'string' },
]);

// Seed the labeled dataset (re-seeds from fixtures every run so the file stays the source of truth).
await api(env, 'DELETE', `/data-tables/${evalTableId}/rows/delete?filter=${encodeURIComponent(JSON.stringify({ type: 'or', filters: [{ columnName: 'email_id', condition: 'like', value: '%' }] }))}`).catch(() => null);
const rows = fixtures().map((e) => ({ email_id: e.id, from: e.from, to: e.to, subject: e.subject, body: e.body, received_at: e.received_at,
  expected_category: e.expected.category, expected_suspicious: e.expected.suspicious, expected_urgent: e.expected.urgent }));
await api(env, 'POST', `/data-tables/${evalTableId}/rows`, { data: rows, returnType: 'count' });
console.log(`seeded ${rows.length} labeled rows into triage_eval_dataset`);

execFileSync(process.execPath, [join(ROOT, 'scripts/build-workflow.mjs'), '--variant', variant, '--out', join(ROOT, 'workflow', '.import.json')], { stdio: 'inherit' });
const wf = JSON.parse(readFileSync(join(ROOT, 'workflow', '.import.json'), 'utf8'));
const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };

if (state.workflowId) {
  await api(env, 'PUT', `/workflows/${state.workflowId}`, body);
  console.log(`updated workflow ${state.workflowId} (${variant})`);
} else {
  const created = await api(env, 'POST', '/workflows', body);
  state.workflowId = created.id; writeLocal(state);
  console.log(`created workflow ${created.id}`);
}
await api(env, 'POST', `/workflows/${state.workflowId}/activate`);
state.variant = variant; writeLocal(state);
console.log(`active. webhook: ${env.url}/webhook/inbox-triage   editor: ${env.url}/workflow/${state.workflowId}`);
