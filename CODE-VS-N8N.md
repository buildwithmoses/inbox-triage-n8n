# When I'd use n8n vs code for a customer

I built the same inbox-triage agent twice:

- **Code:** `src/trigger/inbox-triage.ts` in my automations repo. A Trigger.dev cron task in TypeScript. Composio for Gmail and Slack, the OpenAI SDK pointed at OpenRouter, and Claude Haiku 5.5. 143 lines across 3 files. It reads, sorts, drafts and posts a Slack digest. It never sends.
- **n8n:** this folder. A 24-node workflow on self-hosted n8n 2.44.7, with the same model through the OpenRouter Chat Model node, plus structured output, human approval, guardrails, Gmail/Slack nodes and evals.

The two aren't feature-identical. The n8n version does more because a customer needed more. Where a comparison is unfair, I say so. Numbers come from `DEPLOYMENT-WRITEUP.md`; anything I didn't measure is marked.

## The short answer

**I'd pick n8n** when the hard part is *plumbing*: OAuth to five SaaS apps, waiting on a human, retries, and a run history a non-engineer can open. It also wins when the customer's ops person will own it after I leave.

**I'd pick code** when the hard part is *judgement or scale*:

- logic that needs real tests
- many tenants
- high volume
- strict review and CI
- behaviour that has to be enforced, not configured

**What I'd actually ship to Saltmarsh:** n8n for the pipeline, with the judgement written as small, tested JS modules that are built into the Code nodes. Their team gets a canvas they can read, and I still get unit tests and a CI gate.

## Axis by axis

| Axis | Trigger.dev (code) | n8n | Edge |
|---|---|---|---|
| **Time to build** | Fast for me: the cron, model call and Slack post are ~60 lines. Gmail/Slack auth was outsourced to Composio. Adding approval would mean building it myself (see Approvals). Human build time not measured. | The plumbing was minutes: Gmail Trigger, Slack send-and-wait, Wait, Respond to Webhook and Data tables are all drop-in. Most of the time went into the parts that were code anyway (guardrail, digest, approval parsing; about 200 lines of JS) and into the four platform quirks in "What broke". Human build time not measured; this version was built with an AI coding agent. | **n8n for integrations and approval.** Even. Once the judgement logic exists, the work is the same either way. |
| **Who can maintain it** | Engineers only. A prompt tweak is a PR and a deploy. | Tess's ops lead can follow the canvas, change the Slack channel or the 24h timeout, and read any execution. But the Code nodes and the guardrail regexes still need an engineer. UI edits also drift from the repo unless someone exports and commits them, the same drift problem as the ElevenLabs build. | **n8n**, as long as there's a rule: "UI edits get exported, or they get overwritten". |
| **Approvals** | Not built. In Trigger.dev I'd use a waitpoint token and build the Slack interactivity myself: app, signed requests, button handler, timeout. I haven't built that version, so I can't give a time. | Built in. *Send and wait for response* on Slack and Gmail (approve buttons, free text or a custom form), plus the Wait node for anything else. The resume URL is HMAC-signed and I added header auth. Two sharp edges I hit: a 409 race if you approve instantly, and Slack approvals need the right app scopes. | **n8n, clearly.** This is the strongest reason to use it for this customer. |
| **Observability** | Trigger.dev run logs and traces. I log what I chose to log (`costUsd`, counts). Aggregate metrics and alerts are easy because it's code. | Every execution stores every node's input and output, including LLM token usage per call. That's how I found the 44-calls-for-22-emails bug in two minutes. On self-hosted Community, log streaming and some advanced execution filters are paid features (the instance reports `logStreaming: false`). | **n8n for "what happened to this one email"**, code for fleet-level metrics and alerting. |
| **Evals** | Write any harness you like, gate in CI with an exit code. That's what I did for the LangChain build. | Native Evaluations are good: an Evaluation Trigger on a data table, Set Outputs, Set Metrics, and a run-history UI that shows −18% in red (screenshot 04). But metric evals are license-gated (the public API returned 403 on an unregistered instance), metrics are averaged over every row (a phishing reply showed as 0.95, not 0.67), and there's no hard floor. I kept an external webhook harness and `gate.mjs` as the real gate. | **Code for gating**, n8n for showing the customer. Use both. |
| **Versioning and git** | Native. Diffs are readable, review is normal, and rollback is `git revert`. | Workflow JSON is a poor diff format: node positions, UUIDs, and JS escaped inside JSON strings. Built-in Git source control is a paid feature (`sourceControl: false` on Community). I worked around it with a build step: prompts and Code-node bodies live as real files, `build-workflow.mjs` assembles the JSON, and a test checks the committed JSON matches a fresh build. n8n keeps workflow version history, and named versions are paid. | **Code.** n8n gets close only with extra tooling like mine. |
| **Cost** | LLM: same model, same order of magnitude. Runtime: Trigger.dev bills by compute (not measured for this task). Composio is a separate account. | LLM measured: **$0.0076 per 22-email run** (about $0.00035 per email, about $0.23/month for a daily run). Self-hosted Community has no license fee but you run the box. n8n Cloud bills per execution (not priced here; check current pricing). One n8n-specific cost trap: node-level retry re-ran the whole batch and **doubled LLM cost** whenever item #1 failed. | **Even on LLM spend.** Hosting cost depends on the customer's setup. |
| **Failure handling** | Explicit. I write the try/catch, the budget cap (`BUDGET_USD = 0.25`) and the typed errors. Nothing happens that I didn't write. | Powerful toggles (retry on fail, continue on error, error output, error workflows, wait limits) with non-obvious semantics. Retry checks only the first item. The Basic LLM Chain drops item pairing in batched mode. Hidden reasoning tokens truncated JSON at `maxTokens` 700. The fail-safe still worked: bad output went to "a human should look", never to a send. | **Code** for predictability. n8n is fine once you've read the engine source and tested the toggles you rely on. |
| **Safety guarantees** | Guarantees live in code and tests, like the LangChain build's middleware. | The structure carries some of the safety: a send node is physically downstream of an approval node, and a unit test walks the graph to prove it. The judgement rules still had to be code (the guardrail). | **Even, with discipline.** In both, enforce in code, not the prompt: the naive port *noticed* the injection and replied anyway. |

## What surprised me

1. **The approval step is the product.** The customer's real requirement ("nothing leaves without a person") took about 5 nodes in n8n. In code it would be the biggest chunk of new work.
2. **n8n didn't remove the code; it moved it.** The judgement logic (about 200 lines) is the same size either way. What n8n removed was OAuth, waiting, resuming and the run viewer.
3. **The platform's defaults are where the bugs were.** All four n8n bugs I hit came from a default or toggle behaving differently from what its name suggests. None were in my logic. With code, the bugs are mine and I can read them. With n8n, I had to read `workflow-execute.js` and `ChainLlm.node.js`.
4. **Evals found a bug in my original code version.** The Trigger.dev task's `.slice(0, 600)` hid a 9am deadline. Porting it gave me the excuse to write an eval set, and the eval set caught the old bug.

## Decision checklist I'd use on a customer call

- Will a non-engineer own changes after handoff? → **n8n**
- More than 3 SaaS integrations, or a human approval step? → **n8n**
- Multi-tenant, thousands of runs an hour, or strict latency targets? → **code**
- Needs a hard CI gate, code review and audited change history on a Community plan? → **code**, or n8n plus a build-from-source repo like this one
- Regulated data that can't leave their infrastructure? → either, self-hosted. n8n self-host is a single container; Trigger.dev can also be self-hosted (not tested here).
