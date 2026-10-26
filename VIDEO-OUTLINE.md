# Demo video outline (about 3:00)

**Audience:** an n8n FDE hiring manager. **Angle:** "I ported my own code automation to n8n for a customer. Here's what n8n made easy, what broke, and when I'd still pick code."

**Setup before recording:**
- `docker compose up -d` and `npm run setup`, with the baseline active
- the n8n editor open on the workflow
- a terminal with large font in the project folder
- the Evaluations tab already showing the 5 runs
- `src/trigger/inbox-triage.ts` open in the editor for the first beat

| Time | On screen | Say (roughly) |
|---|---|---|
| 0:00–0:15 | Face cam, then `inbox-triage.ts` (the `.slice(0, 600)` line highlighted) | "This is a 143-line Trigger.dev task I wrote to triage my inbox. A small agency wanted the same thing, with one rule: draft anything, send nothing without a person. So I rebuilt it in n8n, and the evals found a bug in my original code." |
| 0:15–0:40 | `fixtures/emails.json`: e01 (scroll to the 9am line), e07, e06 | "Saltmarsh Creative is fictional, but these are the emails that matter: a 9am deadline buried in a long thread, a fake vendor asking for a wire, and a fake lead with instructions written to the AI." |
| 0:40–1:10 | Canvas (screenshot 01): pan left to right | "Four triggers, one pipeline. A Basic LLM Chain with the OpenRouter Chat Model on Claude Haiku 5.5 and a Structured Output Parser, so every email comes back as category, reason, urgent, suspicious and draft. Then a guardrail in code. Then approval: Slack send-and-wait in production, a signed Wait webhook locally." |
| 1:10–1:45 | Terminal: `npm run triage` prints the digest (🔴 / 🚩 sections). Then `npm run approve -- e01 e02 e06 e21` and `npm run outbox` | "Twenty-two emails in about 18 seconds, for under a cent. The execution is now parked, waiting for a human. I approve three drafts and I also try to approve the phishing email. It's not in the outbox. The workflow only sends ids a person ticked, and suspicious emails never get a sendable draft." |
| 1:45–2:05 | Executions tab (screenshot 02): click the LLM node, show token usage per call | "Every node's input and output is right here. This is how I found that n8n's retry setting re-ran all 22 emails when the first one failed: 44 calls instead of 22, double the cost." |
| 2:05–2:40 | Evaluations tab (03), then run #4 (04): **−18% category accuracy, −5% no-draft-on-suspicious** in red. Then the terminal: `npm run gate` → **GATE FAILED** | "Here's the regression: my original prompt and truncation, no guardrail. It missed the 9am deadline because the first 600 characters cut it off. Worse, it flagged the prompt injection as suspicious and drafted a friendly reply to the attacker anyway. n8n's native evals show the drop, but they average safety over every row, so 0.95 looks fine. My gate treats it as a hard floor and blocks the change." |
| 2:40–3:00 | `CODE-VS-N8N.md` table | "When would I use n8n for a customer? When the hard part is plumbing and a human-in-the-loop, and their ops team will own it. When it's judgement at scale, I'd use code. Here I used both: n8n for the pipeline, tested JS for the judgement. Repo's linked below." |

**B-roll / cutaways:**
- `npm test` going green (25 tests, no API key)
- the graph test name: "no path from any trigger reaches a send node without passing an approval node"
- the curl to `approve_url` without the header → 403
- the `finish_reason: length` at 700 tokens (the hidden-reasoning bug)

**Don't:**
- show `.env`, the n8n API key or the approval token
- show the OpenRouter credential screen with the key unmasked
- claim Gmail or Slack were live; they weren't connected for this demo
- quote numbers that aren't in `DEPLOYMENT-WRITEUP.md`
