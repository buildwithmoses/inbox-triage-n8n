// Inlined into the "Apply approval decision" Code node. Runs after a human responds (or the wait times out).
// Only drafts that a person explicitly approved by id go out. Timeout, empty body, "all", unknown ids -> nothing.

export const SLACK_FIELD = 'Approve these drafts';

export function readDecision(input) {
  const j = input ?? {};
  // Local path: Wait node "On webhook call" -> { body: { approved: ["e01"], edits: { e01: "..." }, approver: "tess" } }
  if (j.body && typeof j.body === 'object') {
    return { approved: Array.isArray(j.body.approved) ? j.body.approved.map(String) : [], edits: j.body.edits ?? {}, approver: String(j.body.approver ?? 'unknown'), via: 'webhook' };
  }
  // Live path: Slack/Gmail "send and wait" with a custom form -> { data: { "Approve these drafts": ["e01 · Re: ..."] } }
  if (j.data && typeof j.data === 'object') {
    const picked = j.data[SLACK_FIELD];
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    return { approved: list.map((s) => String(s).split(' ')[0]), edits: {}, approver: 'slack-form', via: 'slack' };
  }
  return { approved: [], edits: {}, approver: 'none', via: 'timeout-or-empty' };
}

export function applyDecision(drafts, decision) {
  const approvedSet = new Set(decision.approved);
  const sends = [];
  const skipped = [];
  for (const d of drafts) {
    if (!approvedSet.has(d.id)) { skipped.push({ id: d.id, why: 'not approved' }); continue; }
    const edited = typeof decision.edits?.[d.id] === 'string' ? decision.edits[d.id].trim() : '';
    const body = edited || d.draft;
    if (!body) { skipped.push({ id: d.id, why: 'empty draft' }); continue; }
    sends.push({ id: d.id, to: d.to, subject: d.subject, body, edited: Boolean(edited), approved_by: decision.approver, via: decision.via, thread_id: d.thread_id, source: d.source });
  }
  const unknown = decision.approved.filter((id) => !drafts.some((d) => d.id === id));
  return { sends, skipped, unknown };
}
