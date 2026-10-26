#!/usr/bin/env node
// The local stand-in for the Slack "Approve" button.
//   node scripts/approve.mjs run                     # triage the 22 fixtures; prints the digest + approve_url, saves it
//   node scripts/approve.mjs approve e09 e21         # approve those drafts (everything else is NOT sent)
//   node scripts/approve.mjs approve e21 --edit e21="Hi Jen, attached again! Tess"
//   node scripts/approve.mjs reject                  # approve nothing; the run finishes and sends nothing
//   node scripts/approve.mjs outbox                  # show what was "sent"
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, api, readLocal } from './lib.mjs';

const env = loadEnv();
const [cmd, ...rest] = process.argv.slice(2);
const pending = join(ROOT, '.pending-approval.json');

if (cmd === 'run') {
  const t0 = performance.now();
  const res = await fetch(`${env.url}/webhook/inbox-triage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const d = await res.json();
  console.log(d.digest_markdown);
  console.log(`\n${d.counts.total} emails in ${Math.round(performance.now() - t0)} ms · execution ${d.execution_id} is now WAITING for approval`);
  console.log(`drafts: ${d.drafts.map((x) => x.id).join(', ')}`);
  writeFileSync(pending, JSON.stringify({ approve_url: d.approve_url, execution_id: d.execution_id, drafts: d.drafts.map((x) => x.id) }, null, 2));
} else if (cmd === 'approve' || cmd === 'reject') {
  if (!existsSync(pending)) throw new Error('nothing pending; run `node scripts/approve.mjs run` first');
  const p = JSON.parse(readFileSync(pending, 'utf8'));
  const approved = cmd === 'reject' ? [] : rest.filter((a) => !a.startsWith('--') && !a.includes('='));
  const edits = Object.fromEntries(rest.filter((a) => a.includes('=')).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; }));
  // 409 = the Wait node hasn't parked the execution yet (Respond to Webhook answers first). Retry briefly.
  let res;
  for (let i = 0; i < 10; i++) {
    res = await fetch(p.approve_url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Approval-Token': env.approvalToken ?? '' }, body: JSON.stringify({ approved, edits, approver: 'tess' }) });
    if (res.status !== 409) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`resume -> HTTP ${res.status}. approved: [${approved.join(', ')}]`);
} else if (cmd === 'outbox') {
  const { outboxTableId } = readLocal();
  const rows = await api(env, 'GET', `/data-tables/${outboxTableId}/rows?limit=100`);
  for (const r of rows.data ?? []) console.log(`${r.sent_at}  ${r.email_id} -> ${r.to}  (${r.approved_by}${r.edited ? ', edited' : ''})\n   ${r.body.replace(/\n+/g, ' ').slice(0, 160)}`);
  if (!rows.data?.length) console.log('(outbox empty)');
} else {
  console.log('usage: approve.mjs run | approve <ids...> [id="edited text"] | reject | outbox');
}
