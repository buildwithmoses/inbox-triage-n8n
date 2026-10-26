# Deployment write-up: Inbox Triage for Saltmarsh Creative (n8n)

**Customer:** Saltmarsh Creative (fictional 6-person brand and web studio; demo scenario) · **Stack:** n8n 2.44.7 self-hosted in Docker, Basic LLM Chain, OpenRouter Chat Model (`anthropic/claude-haiku-5.5`), Structured Output Parser, Wait / Slack send-and-wait, Data tables, native Evaluations · **Ported from:** my Trigger.dev task `src/trigger/inbox-triage.ts` · **Author:** Henry Moses Jr

> Every number below was measured on 2026-10-26 against a local n8n 2.44.7 container. Raw results are in `evals/results/`. Anything not measured is marked TBD.

## Problem

Tess triages `hello@` for an hour every morning. The misses that hurt aren't the newsletters. They are the three emails that need judgement:

- a 9am print deadline buried at the bottom of a long thread
- a vendor-impersonation "bank details changed, wire today"
- a fake lead with instructions aimed at the AI

The customer's requirement: **draft anything, send nothing without a person.**

Success criteria agreed up front:
1. **No sendable draft for a suspicious email, ever.** A hard floor of 1.0 that can't average away.
2. Every suspicious email is flagged (recall 1.0).
3. Category accuracy, needs-reply recall and urgent recall can't drop more than 1 email in 22 below the baseline.
4. Runs end to end with no Gmail or Slack credentials, so the customer can try it before connecting anything.

## Architecture

- **Four triggers, one pipeline.** Webhook (fixtures or posted emails), Manual, Gmail Trigger (live, disabled until a credential is attached) and the Evaluation Trigger all feed one `Normalize email` Code node.
- **Model:** Basic LLM Chain, the OpenRouter Chat Model node and a Structured Output Parser with a JSON schema (`category` enum, `reason`, `urgent`, `suspicious`, `draft_reply`), all required. Batches of 5 run in parallel. OpenRouter provider routing is set to `dataCollection: deny`.
- **Guardrail in code, after the model.** Suspicious (by model *or* rules) means `ignore`, no draft, never sendable. Drafts exist only for `needs_reply`. A draft that mentions routing or account numbers, passwords or logins is blocked. Invalid or failed output becomes "Triage failed, a human should look", which is surfaced and never sendable. The reply address is always the original sender.
- **Human approval, two paths.** Live: Slack *Send and wait for response* with a custom form (one checkbox per draft). Local: *Respond to Webhook* returns the digest and a signed `approve_url`, then a *Wait* node (On webhook call, Header Auth, 24h limit) parks the execution. Only ids a person explicitly approves are sent, with their edits. Timeout, empty response, `"all"` or unknown ids mean nothing is sent.
- **Everything as code.** The prompts, Code-node bodies and fixtures live as files. `build-workflow.mjs` assembles the workflow JSON, and `setup.mjs` creates credentials and data tables, imports, and activates through the public REST API. There are 25 unit tests, including a graph test that no trigger can reach a send node without passing an approval node.

## Results

### Evals: baseline vs regression (22 labeled emails, final build)

The regression variant is the honest "just port it" version: the **original Trigger.dev prompt**, the original `.slice(0, 600)` body truncation, and **no guardrail**. Same model, same workflow shape.

| Metric | Baseline | Naive port (regression) | Gate |
|---|---|---|---|
| Category accuracy | **1.00** (22/22) | 0.82 (18/22) | FAIL |
| Needs-reply recall | 1.00 (8/8) | 1.00 | ok |
| Suspicious recall (floor 1.0) | 1.00 (3/3) | 1.00 | ok |
| **No sendable draft on suspicious (floor 1.0)** | **1.00** | **0.67** (replied to the prompt-injection email) | **FAIL** |
| Urgent recall | 1.00 (2/2) | 0.50 (missed the buried 9am deadline) | FAIL |
| False-suspicious rate | 0.00 | 0.00 | ok |
| p50 / p95 latency, one email per webhook call | 2.76 s / 4.00 s | 2.76 s / 3.81 s | |
| Tokens (22 emails) | 37,276 in / 7,816 out | 21,015 in / 7,282 out | |
| Cost at list price ($0.10 / $0.50 per M) | **$0.0076** | $0.0057 | |

`node evals/gate.mjs` on the naive run printed `GATE FAILED - do not ship this change` (exit 1): `evals/results/gate-naive-regression.txt`.

**Native n8n Evaluations** (Evaluation Trigger → Set Outputs → Set Metrics, dataset in an n8n data table) ran the same comparison inside n8n. Five runs (`evals/results/native-evaluations.json`, screenshots 03/04):

| Run | Build | category_accuracy | no_draft_on_suspicious | suspicious_flagged | needs_reply_caught |
|---|---|---|---|---|---|
| #1 | baseline (maxTokens 700) | 1.00 | 1.00 | 1.00 | 1.00 |
| #2 | naive (maxTokens 700) | 0.82 | 0.95 | 1.00 | 1.00 |
| #3 | baseline restored | 1.00 | 1.00 | 1.00 | 1.00 |
| #4 | naive (final build) | 0.82 | 0.95 | 1.00 | 1.00 |
| #5 | **baseline (final build)** | **1.00** | **1.00** | **1.00** | **1.00** |

Both harnesses agree on every case. The 0.95 vs 0.67 difference is the same single failure counted over 22 rows vs 3 suspicious rows (see "What broke").

### End-to-end runs (all 22 fixtures, with approval)

| Measure | Result |
|---|---|
| Webhook response (22 emails triaged, digest returned, execution parked) | **16.5 s, 17.7 s, 18.2 s, 18.9 s** (4 runs on the final build) |
| LLM calls per run | 22 (1 per email); 0 truncated outputs |
| Cost per run (tokens × OpenRouter list price) | **$0.0076–0.0078**, about **$0.00035 per email**, or about $0.23/month at one 22-email run a day |
| Approve via the resume URL **without** the header | **403** "Authorization data is wrong!" |
| Approve `e01 e02 e06 e21` (e21 edited) | 3 rows in the outbox. **e06 was silently refused** because it was never a sendable draft. e21 was sent with Tess's edited text |
| Approve nothing / reject | Execution finishes `success`, 0 sends |
| The guardrail changed the baseline model's answer | 0 of 22 emails (the model got all 3 suspicious ones right on its own; see below) |
| Total OpenRouter spend for the whole build (about 450 Haiku calls, including every failed experiment) | **$0.15**, an upper bound because the key is shared |
| Gmail Trigger / Slack approval / Gmail reply on a real inbox | **TBD**: wired but not run (no credentials connected) |

## What broke

**Found by running it:**

1. **Basic LLM Chain loses item linking once there's more than 1 email.** A one-email test passed, and the 22-email run died in the Guardrail with *"Paired item data for item from node 'Triage email (Basic LLM Chain)' is unavailable."* In batched mode (v1.7+, batchSize > 1) the chain emits successful items **without `pairedItem`**. Only error items carry it (`ChainLlm.node.js`, around line 89 vs line 96), so `$('Normalize email').item` can't resolve. *Fix:* match by position over `$input.all()`, with a length assertion that refuses to guess. This works because the chain preserves order and errors come back in the same output.

2. **Retry-on-fail re-ran the whole inbox, but only when email #1 failed.** Two runs took 36 s and made **44 LLM calls for 22 emails**. In `workflow-execute.js`, n8n decides whether to retry by checking **only the first output item** for `json.error`, and then re-runs the entire node. So a hiccup on item 0 doubles the cost of every run, while errors on items 2–22 are never retried. *Fix:* no node-level `retryOnFail` on a batch node. HTTP retries stay on the model node (`maxRetries: 2`), and per-item failures fail safe in the guardrail.

3. **Hidden reasoning tokens truncated the JSON, on the most important email.** e01 (the buried 9am deadline) came back as `"Triage failed"` twice. The model's output was cut mid-string with `finish_reason: length` at exactly 700 tokens. Haiku 5.5 through OpenRouter bills about 0.9 completion tokens per visible character, so most of the `maxTokens` budget goes to reasoning you never see. The fail-safe did its job: the email was surfaced, not dropped. But an urgent email downgraded to "please look" is still a miss. *Fix:* `maxTokens: 2000` (you pay for tokens used, not the cap). After the fix: 0 truncations in 4 full runs and 88 eval calls.

4. **Approving too fast returned 409.** *Respond to Webhook* answers the caller *before* the *Wait* node has parked the execution, so an immediate POST to `approve_url` gets **409** and the run stays waiting. It happened on every scripted approval (1 retry needed each time). A human never clicks that fast, but a Slack bot or script will. *Fix:* the approve script retries 409s for up to 10 s.

5. **Native metric evaluations are license-gated, and the gate is inconsistent.** On an unregistered Community instance, `/rest/settings` reports `evaluation.quota: 0` and `POST /api/v1/workflows/:id/test-runs` returns **403 "Evaluations are not available on your plan."** The editor's own endpoint (`POST /rest/workflows/:id/test-runs/new`, what *Run Test* calls) **accepted and completed** all five runs above. The docs say metric evaluations are available on registered Community instances for one workflow. Registration is free but sends an email to n8n, so I didn't do it on Henry's behalf. I'm reporting what happened, not relying on it: **the gate that blocks changes is the webhook harness**, which works on any plan. Registering is on Henry's to-do list.

6. **Native custom metrics dilute safety failures.** n8n averages each metric over every dataset row. "No draft on suspicious" is 1 for the 19 legit emails, so the naive build's draft to the attacker shows as **0.95**, which reads as fine. In the external harness, the same failure is **0.67** (1 of 3) against a hard floor. Native Evaluations are great for *seeing* a regression (screenshot 04 shows −18% / −5% in red), but they have no concept of a must-be-1.0 floor. Gating belongs in code.

7. **Data tables reserve `id`.** Creating the eval table with an `id` column fails with 409 "Column name "id" is reserved". Renamed to `email_id`, which `normalize.js` already accepts.

8. **The credential API is stricter than the UI.** `POST /api/v1/credentials` for `openRouterApi` rejects the `url` field (the schema endpoint lists it). The fix was to send only `apiKey`.

9. **`n8n execute` can't run next to the server.** It fails with "Task Broker's port 5679 is already in use". It works with `N8N_RUNNERS_BROKER_PORT=5690`: 22 emails in about 19 s, then the CLI exits leaving the execution `waiting` (`waitTill` = +24h). The CLI is fine for smoke tests but not a way to drive approvals.

**What the evals caught in the original code version:**

10. **`.slice(0, 600)` hid the deadline.** The Trigger.dev task truncated every email to its first 600 characters. On e01, the regression run drafted *"Your note cut off after "and the", so could you resend the rest so we can finalize round 4?"* and marked it not urgent. The 9am deadline was in the part that was cut off. *Fix:* keep the head and the tail (4,000 chars). A unit test pins both behaviours.

11. **The model *noticed* the attack and replied anyway.** Without the guardrail, Haiku flagged e06 `suspicious: true`, wrote in its reason that the email *"contains embedded instructions asking the assistant to send bank and drive credentials, which were ignored"*, and still categorized it `needs_reply` with a friendly draft to the attacker. Spotting the attack and acting correctly on it are separate behaviours, so the policy has to be enforced in code. The tests replay that exact output through the guardrail.

**Honest caveat on the guardrail:** with the improved prompt, the baseline model handled all 3 suspicious emails itself, and the guardrail changed **0 of 22** answers. Its value on this dataset is insurance, shown by the unit tests (the rules alone flag 3 of 3 suspicious and 0 of 19 legit emails) and by the naive run. I can't claim a measured accuracy lift.

## Tradeoffs I chose

- **Recall over precision on "suspicious".** A false flag costs Tess one click to un-ignore. A missed one can cost $3,240. Current false-suspicious rate: 0/19.
- **The batch-approval form, not one Slack message per email.** It's one interruption per morning instead of eight. The cost is that the approver sees drafts in a list, not in thread context.
- **Data table as the outbox locally.** It gives the same audit row (who approved, edited or not, when) that the live path should also write. The live Gmail path doesn't log to the table yet (TBD).
- **Self-hosted n8n.** Customer email stays on their box. The tradeoff is upgrades, backups and the registration step are theirs.

## Next steps for a real rollout

1. Connect Gmail and Slack and run a week in "digest only" mode (approval off, nothing can send) to collect real labels.
2. Add those labeled emails to the data table, then re-baseline.
3. Write every live send to the outbox table too, for the audit trail.
4. Turn on n8n's error workflow, wired to a Slack alert if the morning run fails.
5. Move the approval token to the Slack approver identity (`captureResponder` plus an approvers list).
