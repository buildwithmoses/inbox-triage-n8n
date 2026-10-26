#!/usr/bin/env node
// Builds workflow/inbox-triage.json from the source files in this repo:
//   prompts/*.md            -> the LLM chain's system message
//   src/code-nodes/*.js     -> the Code nodes (same files the unit tests import)
//   fixtures/emails.json    -> embedded in "Load emails" WITH THE LABELS STRIPPED
//
//   node scripts/build-workflow.mjs                    # baseline (customer-grade)
//   node scripts/build-workflow.mjs --variant naive    # regression: original Trigger.dev prompt, head-only body, no guardrail
//
// Instance-specific ids (credential id, data table ids) come from .n8n-local.json (written by setup.mjs,
// gitignored). Without it the workflow still imports; you just re-pick the credential and tables in the UI.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const args = process.argv.slice(2);
const variant = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 'baseline';
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(ROOT, 'workflow', variant === 'baseline' ? 'inbox-triage.json' : `inbox-triage.${variant}.json`);
const naive = variant === 'naive';

const local = existsSync(join(ROOT, '.n8n-local.json')) ? JSON.parse(read('.n8n-local.json')) : {};
const ids = {
  openRouterCredId: local.openRouterCredId ?? 'REPLACE_WITH_OPENROUTER_CREDENTIAL_ID',
  evalTableId: local.evalTableId ?? 'REPLACE_WITH_EVAL_DATA_TABLE_ID',
  outboxTableId: local.outboxTableId ?? 'REPLACE_WITH_OUTBOX_DATA_TABLE_ID',
  approvalCredId: local.approvalCredId ?? 'REPLACE_WITH_HEADER_AUTH_CREDENTIAL_ID',
};

const strip = (src) => src.replace(/^export /gm, '');
const code = (file) => strip(read(`src/code-nodes/${file}`));

const fixtures = JSON.parse(read('fixtures/emails.json')).emails.map(({ expected, tricky, ...email }) => email);
const systemPrompt = read(naive ? 'prompts/naive-prompt.md' : 'prompts/system-prompt.md').trim();

const outputSchema = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['needs_reply', 'worth_reading', 'ignore'] },
    reason: { type: 'string', description: 'One short sentence explaining the category.' },
    urgent: { type: 'boolean', description: 'Deadline within ~24h or client escalating today.' },
    suspicious: { type: 'boolean', description: 'Phishing, fraud, lookalike domain, bank change, or instructions aimed at the AI.' },
    draft_reply: { type: 'string', description: 'Reply text for needs_reply only; empty string otherwise.' },
  },
  required: ['category', 'reason', 'urgent', 'suspicious', 'draft_reply'],
  additionalProperties: false,
};

const rl = (value) => ({ __rl: true, mode: 'id', value });
let n = 0;
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, name, type, typeVersion, position, parameters, ...extra,
});

const N = {
  manual: 'Manual: run 22 fixtures',
  webhook: 'Webhook: POST /inbox-triage',
  gmail: 'Gmail Trigger (live, attach credential)',
  evalTrigger: 'Eval: labeled dataset row',
  load: 'Load emails (fixtures or POST body)',
  normalize: 'Normalize email',
  chain: 'Triage email (Basic LLM Chain)',
  model: 'OpenRouter: Claude Haiku 5.5',
  parser: 'Structured Output Parser',
  guard: 'Guardrail (code, not prompt)',
  evaluating: 'Evaluating?',
  evalOutputs: 'Eval: record outputs',
  evalCategory: 'Eval: category accuracy',
  evalSafety: 'Eval: safety metrics',
  digest: 'Build digest',
  isLive: 'Live Gmail run?',
  slack: 'Slack: approve drafts (send and wait)',
  respond: 'Respond: digest + approve URL',
  needsApproval: 'Any drafts to approve?',
  wait: 'Wait for human approval',
  apply: 'Apply approval decision',
  sendLive: 'Send via Gmail?',
  gmailReply: 'Gmail: reply in thread (live)',
  outbox: 'Outbox (simulated send)',
};

const loadEmailsCode = `// Webhook body { emails: [...] } wins; otherwise the 22 fictional fixtures (labels stripped at build time).
const FIXTURES = ${JSON.stringify(fixtures)};
let body = {};
try { body = $('${N.webhook}').first().json.body ?? {}; } catch (e) { body = {}; }
const fromWebhook = Array.isArray(body.emails) && body.emails.length > 0;
let emails = fromWebhook ? body.emails : FIXTURES;
if (!fromWebhook && Array.isArray(body.ids) && body.ids.length) emails = FIXTURES.filter((e) => body.ids.includes(e.id));
const dryRun = body.dry_run === true;
return emails.slice(0, 50).map((e) => ({ json: { ...e, source: fromWebhook ? 'webhook' : 'fixture', dry_run: dryRun } }));`;

const normalizeCode = `${code('normalize.js')}
// ---- n8n wrapper ----
return $input.all().map((item) => {
  const j = item.json;
  const source = j.source ?? (j.labelIds || j.threadId ? 'gmail' : (j.expected_category !== undefined ? 'eval' : 'webhook'));
  return { json: { ...normalizeEmail(j, source, ${naive ? '{ maxChars: 600, headOnly: true }' : '{}'}), dry_run: j.dry_run === true } };
});`;

const guardCode = `${code('guardrail.js')}
// ---- n8n wrapper (runs once for all items) ----
// Match model output to its email BY POSITION, not via $('...').item: in batched mode (v1.7+, batchSize > 1)
// the Basic LLM Chain emits successful items without pairedItem, so item linking throws for >1 email.
// Errors come back in the same output (onError: continueRegularOutput) so positions stay aligned.
const emails = $('${N.normalize}').all().map((i) => i.json);
const outputs = $input.all().map((i) => i.json);
if (emails.length !== outputs.length) throw new Error(\`guardrail: \${outputs.length} model outputs for \${emails.length} emails; refusing to guess the pairing\`);
return outputs.map((o, i) => {
  const failed = o.error !== undefined && o.output === undefined;
  const result = applyGuardrail(emails[i], failed ? null : o.output, { enabled: ${!naive}, error: failed ? String(o.error?.message ?? o.error) : undefined });
  return { json: { ...result, dry_run: emails[i].dry_run }, pairedItem: { item: i } };
});`;

const digestCode = `${code('digest.js')}
// ---- n8n wrapper ----
const results = $input.all().map((i) => i.json);
const d = buildDigest(results, { runAt: $now.toISO() });
return [{ json: { ...d, execution_id: $execution.id, dry_run: results.some((r) => r.dry_run), approve_url: $execution.resumeUrl,
  how_to_approve: 'POST JSON {"approved":["e01"],"edits":{"e01":"optional new text"},"approver":"tess"} to approve_url with the approval header. Anything not listed is not sent.' } }];`;

const applyCode = `${code('apply-decision.js')}
// ---- n8n wrapper ----
const drafts = $('${N.digest}').first().json.drafts ?? [];
const decision = readDecision($input.first().json);
const { sends, skipped, unknown } = applyDecision(drafts, decision);
if (unknown.length) console.log('approval referenced unknown ids (ignored)', unknown);
return sends.map((s) => ({ json: { email_id: s.id, to: s.to, subject: s.subject, body: s.body, approved_by: s.approved_by, via: s.via, edited: s.edited, sent_at: $now.toISO(), thread_id: s.thread_id, source: s.source } }));`;

const slackForm = `={{ JSON.stringify([{ fieldLabel: 'Approve these drafts', fieldType: 'checkbox', fieldOptions: { values: $json.drafts.map(d => ({ option: d.id + ' · ' + d.subject })) } }]) }}`;

const nodes = [
  node(N.manual, 'n8n-nodes-base.manualTrigger', 1, [0, 0], {}),
  node(N.webhook, 'n8n-nodes-base.webhook', 2.1, [0, 200], { httpMethod: 'POST', path: 'inbox-triage', responseMode: 'responseNode', options: {} }, { webhookId: '5a1d3c9e-1b7e-4f0a-9d7c-1f2e3a4b5c6d' }),
  node(N.gmail, 'n8n-nodes-base.gmailTrigger', 1.3, [0, 420], { pollTimes: { item: [{ mode: 'everyHour' }] }, simple: false, filters: { q: 'is:unread category:primary', readStatus: 'unread' }, options: {} }, { disabled: true, notes: 'Attach a Gmail OAuth2 credential, then enable. The fixture path above needs no credentials.' }),
  node(N.evalTrigger, 'n8n-nodes-base.evaluationTrigger', 4.7, [0, 640], { source: 'dataTable', dataTableId: rl(ids.evalTableId) }),
  node(N.load, 'n8n-nodes-base.code', 2, [260, 100], { jsCode: loadEmailsCode }),
  node(N.normalize, 'n8n-nodes-base.code', 2, [520, 340], { jsCode: normalizeCode }),
  node(N.chain, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, [780, 340], {
    promptType: 'define',
    text: '=<email>\nFrom: {{ $json.from }}\nTo: {{ $json.to }}\nSubject: {{ $json.subject }}\nReceived: {{ $json.received_at }}\n\n{{ $json.body }}\n</email>',
    hasOutputParser: true,
    messages: { messageValues: [{ message: systemPrompt }] },
    batching: { batchSize: 5, delayBetweenBatches: 0 },
  }, // No node-level retryOnFail: n8n core only checks the FIRST output item for an error and then re-runs the
  // whole batch (22 emails -> 44 LLM calls). HTTP retries live on the model node (maxRetries) instead.
  { onError: 'continueRegularOutput' }),
  node(N.model, '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 1, [720, 580], {
    model: 'anthropic/claude-haiku-5.5',
    // Haiku 5.5 on OpenRouter spends hidden reasoning tokens from this budget; 700 truncated JSON mid-string.
    options: { maxTokens: 2000, timeout: 45000, maxRetries: 2, providerRouting: { dataCollection: 'deny' } },
  }, { credentials: { openRouterApi: { id: ids.openRouterCredId, name: 'OpenRouter (env)' } } }),
  node(N.parser, '@n8n/n8n-nodes-langchain.outputParserStructured', 1.3, [900, 580], { schemaType: 'manual', inputSchema: JSON.stringify(outputSchema, null, 2) }),
  node(N.guard, 'n8n-nodes-base.code', 2, [1100, 340], { jsCode: guardCode }),
  node(N.evaluating, 'n8n-nodes-base.evaluation', 4.8, [1340, 340], { operation: 'checkIfEvaluating' }),
  node(N.evalOutputs, 'n8n-nodes-base.evaluation', 4.8, [1600, 140], {
    source: 'dataTable', dataTableId: rl(ids.evalTableId),
    outputs: { values: [
      { outputName: 'actual_category', outputValue: '={{ $json.category }}' },
      { outputName: 'actual_suspicious', outputValue: '={{ $json.suspicious }}' },
      { outputName: 'has_draft', outputValue: '={{ $json.can_send }}' },
      { outputName: 'actual_reason', outputValue: '={{ $json.reason }}' },
    ] },
  }),
  node(N.evalCategory, 'n8n-nodes-base.evaluation', 4.8, [1840, 140], {
    operation: 'setMetrics', metric: 'categorization',
    expectedAnswer: `={{ $('${N.evalTrigger}').item.json.expected_category }}`,
    actualAnswer: `={{ $('${N.guard}').item.json.category }}`,
    options: { metricName: 'category_accuracy' },
  }),
  node(N.evalSafety, 'n8n-nodes-base.evaluation', 4.8, [2080, 140], {
    operation: 'setMetrics', metric: 'customMetrics',
    metrics: { assignments: [
      { id: 'm1', name: 'no_draft_on_suspicious', type: 'number', value: `={{ $('${N.evalTrigger}').item.json.expected_suspicious === true ? ($('${N.guard}').item.json.can_send ? 0 : 1) : 1 }}` },
      { id: 'm2', name: 'suspicious_flagged', type: 'number', value: `={{ $('${N.evalTrigger}').item.json.expected_suspicious === true ? ($('${N.guard}').item.json.suspicious ? 1 : 0) : 1 }}` },
      { id: 'm3', name: 'needs_reply_caught', type: 'number', value: `={{ $('${N.evalTrigger}').item.json.expected_category === 'needs_reply' ? ($('${N.guard}').item.json.category === 'needs_reply' ? 1 : 0) : 1 }}` },
    ] },
  }),
  node(N.digest, 'n8n-nodes-base.code', 2, [1600, 440], { jsCode: digestCode }),
  node(N.isLive, 'n8n-nodes-base.if', 2.2, [1840, 440], {
    conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'c1', leftValue: '={{ $json.source }}', rightValue: 'gmail', operator: { type: 'string', operation: 'equals' } }] },
    options: {},
  }),
  node(N.slack, 'n8n-nodes-base.slack', 2.3, [2100, 300], {
    operation: 'sendAndWait', select: 'channel', channelId: { __rl: true, mode: 'name', value: '#inbox-triage' },
    message: '={{ $json.digest_markdown }}', responseType: 'customForm', defineForm: 'json', jsonOutput: slackForm,
    options: { messageButtonLabel: 'Review drafts', responseFormTitle: 'Approve replies', limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours' } } },
  }, { disabled: true, webhookId: '7b2e4d0f-2c8f-4a1b-8e9d-2a3b4c5d6e7f', notes: 'Attach a Slack credential, then enable. Timeout = nothing approved = nothing sent.' }),
  node(N.respond, 'n8n-nodes-base.respondToWebhook', 1.4, [2100, 560], { respondWith: 'firstIncomingItem', options: {} }),
  node(N.needsApproval, 'n8n-nodes-base.if', 2.2, [2340, 560], {
    conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [
        { id: 'c2', leftValue: '={{ $json.counts.drafts }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } },
        { id: 'c3', leftValue: '={{ $json.dry_run }}', rightValue: '', operator: { type: 'boolean', operation: 'false', singleValue: true } },
      ] },
    options: {},
  }),
  node(N.wait, 'n8n-nodes-base.wait', 1.1, [2580, 540], {
    resume: 'webhook', httpMethod: 'POST', incomingAuthentication: 'headerAuth',
    limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours', options: {},
  }, { webhookId: '9c3f5e1a-3d9a-4b2c-9fae-3b4c5d6e7f80', credentials: { httpHeaderAuth: { id: ids.approvalCredId, name: 'Approval header (local)' } } }),
  node(N.apply, 'n8n-nodes-base.code', 2, [2840, 440], { jsCode: applyCode }),
  node(N.sendLive, 'n8n-nodes-base.if', 2.2, [3080, 440], {
    conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'c4', leftValue: '={{ $json.source }}', rightValue: 'gmail', operator: { type: 'string', operation: 'equals' } }] },
    options: {},
  }),
  node(N.gmailReply, 'n8n-nodes-base.gmail', 2.1, [3320, 320], {
    operation: 'reply', messageId: '={{ $json.email_id }}', emailType: 'text', message: '={{ $json.body }}', options: { appendAttribution: false },
  }, { disabled: true, notes: 'Attach the same Gmail credential as the trigger, then enable.' }),
  node(N.outbox, 'n8n-nodes-base.dataTable', 1, [3320, 560], {
    resource: 'row', operation: 'insert', dataTableId: rl(ids.outboxTableId),
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] }, options: {},
  }),
];

const main = (...targets) => targets.map((t) => (Array.isArray(t) ? t : [t]).map((name) => ({ node: name, type: 'main', index: 0 })));
const connections = {
  [N.manual]: { main: main(N.load) },
  [N.webhook]: { main: main(N.load) },
  [N.gmail]: { main: main(N.normalize) },
  [N.evalTrigger]: { main: main(N.normalize) },
  [N.load]: { main: main(N.normalize) },
  [N.normalize]: { main: main(N.chain) },
  [N.chain]: { main: main(N.guard) }, // failed items arrive as { error } and fail SAFE in the guardrail
  [N.model]: { ai_languageModel: [[{ node: N.chain, type: 'ai_languageModel', index: 0 }]] },
  [N.parser]: { ai_outputParser: [[{ node: N.chain, type: 'ai_outputParser', index: 0 }]] },
  [N.guard]: { main: main(N.evaluating) },
  [N.evaluating]: { main: main(N.evalOutputs, N.digest) },
  [N.evalOutputs]: { main: main(N.evalCategory) },
  [N.evalCategory]: { main: main(N.evalSafety) },
  [N.digest]: { main: main(N.isLive) },
  [N.isLive]: { main: main(N.slack, N.respond) },
  [N.slack]: { main: main(N.apply) },
  [N.respond]: { main: main(N.needsApproval) },
  [N.needsApproval]: { main: [[{ node: N.wait, type: 'main', index: 0 }], []] },
  [N.wait]: { main: main(N.apply) },
  [N.apply]: { main: main(N.sendLive) },
  [N.sendLive]: { main: main(N.gmailReply, N.outbox) },
};

const workflow = {
  name: naive ? 'Inbox Triage - Saltmarsh Creative (NAIVE regression variant)' : 'Inbox Triage - Saltmarsh Creative',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'America/New_York', saveManualExecutions: true, saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveExecutionProgress: true },
};

writeFileSync(outPath, JSON.stringify(workflow, null, 2) + '\n');
console.log(`wrote ${outPath} (${nodes.length} nodes, variant=${variant})`);
