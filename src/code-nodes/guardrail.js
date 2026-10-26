// Inlined into the "Guardrail (code, not prompt)" Code node by scripts/build-workflow.mjs.
// Runs AFTER the model. Deterministic rules that the model can't talk its way past:
//   1. Suspicious email (model OR rules say so) -> category ignore, no draft, can never be sent.
//   2. Drafts only exist for needs_reply.
//   3. A draft that leaks bank details / credentials is blocked.
//   4. Bad or missing model output fails SAFE: surfaced to a human, never silently ignored.
//   5. The reply address is always the original sender, never anything the model or email says.

export const CATEGORIES = ['needs_reply', 'worth_reading', 'ignore'];

// The customer's real correspondents. A domain that imitates one of these is a red flag.
export const KNOWN_DOMAINS = [
  'harborpine.example', 'lowcountrykayak.example', 'bellwetherbrewing.example', 'juniperdental.example',
  'printworks-sav.example', 'marcoruiz-illustration.example', 'ninafeld-photo.example', 'flywheelhost.example',
  'saltmarsh.example', 'google.example', 'stripe.example', 'docusign.example', 'asana.example', 'figma.example',
];
const BRANDS = ['google', 'microsoft', 'stripe', 'docusign', 'paypal', 'printworks', 'harborpine', 'bellwether'];

export const RULES = [
  { id: 'prompt_injection', re: /ignore (all |any |your )?(previous|prior|above|earlier) instructions|note to the ai|instructions? (for|to) the (ai|assistant)|do not mention this note/i },
  { id: 'bank_change', re: /(new|updated|changed?|different) (bank|banking|payment|wire) (details|account|info|information|instructions)|we have changed banks|changed our bank/i },
  { id: 'credential_request', re: /verify (your )?(account|password|identity|login)|password (will )?expire|confirm your (password|credentials)/i },
  { id: 'secrecy_pressure', re: /keep this confidential and do not call|do not call our office/i },
];

export function lookalikeDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d || KNOWN_DOMAINS.includes(d)) return null;
  const deDigit = d.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e');
  for (const brand of BRANDS) {
    if (!d.includes(brand) && deDigit.includes(brand)) return `${d} imitates ${brand} (digit swap)`;
  }
  for (const known of KNOWN_DOMAINS) {
    const stem = known.replace(/\.example$/, '');
    if (stem.length >= 6 && d.includes(stem)) return `${d} looks like ${known} but isn't`;
  }
  return null;
}

export function screenEmail(email) {
  const text = `${email.subject ?? ''}\n${email.body ?? ''}`;
  const reasons = RULES.filter((r) => r.re.test(text)).map((r) => r.id);
  const look = lookalikeDomain(email.from_domain);
  if (look) reasons.push(`lookalike_domain: ${look}`);
  return reasons;
}

const DRAFT_LEAK = /\b(routing (number|no)|account (number|no)|password|passcode|login (details|credentials)|wire (to|instructions))\b/i;

export function applyGuardrail(email, modelOutput, opts = {}) {
  const enabled = opts.enabled !== false;
  const out = modelOutput && typeof modelOutput === 'object' ? modelOutput : null;
  const base = {
    id: email.id, thread_id: email.thread_id, source: email.source,
    from: email.from, reply_to: email.from_address, subject: email.subject,
  };

  if (!out || !CATEGORIES.includes(out.category)) {
    return { ...base, category: 'worth_reading', reason: `Triage failed (${opts.error ?? 'invalid model output'}); a human should look.`,
      urgent: false, suspicious: false, suspicious_reasons: [], draft_reply: '', can_send: false,
      model_category: out?.category ?? null, guardrail_overrode: true, triage_error: true };
  }

  let category = out.category;
  let draft = String(out.draft_reply ?? '').trim();
  const modelSuspicious = out.suspicious === true;
  const ruleReasons = enabled ? screenEmail(email) : [];
  const suspicious = modelSuspicious || ruleReasons.length > 0;
  const notes = [];

  if (!enabled) {
    // Regression variant: trust the model completely (this is what the naive port does).
    return { ...base, category, reason: String(out.reason ?? ''), urgent: out.urgent === true, suspicious: modelSuspicious,
      suspicious_reasons: [], draft_reply: draft, can_send: draft.length > 0,
      model_category: out.category, guardrail_overrode: false, triage_error: false };
  }

  if (suspicious) {
    if (category !== 'ignore') notes.push(`category ${category} -> ignore (suspicious)`);
    category = 'ignore';
    if (draft) notes.push('draft removed (suspicious)');
    draft = '';
  }
  if (category !== 'needs_reply' && draft) { notes.push('draft removed (not needs_reply)'); draft = ''; }
  if (draft && DRAFT_LEAK.test(draft)) { notes.push('draft blocked (mentions bank/credential details)'); draft = ''; }

  return {
    ...base, category, reason: String(out.reason ?? ''), urgent: out.urgent === true && !suspicious,
    suspicious, suspicious_reasons: modelSuspicious ? ['model', ...ruleReasons] : ruleReasons,
    draft_reply: draft, can_send: draft.length > 0 && !suspicious,
    model_category: out.category, guardrail_overrode: notes.length > 0, guardrail_notes: notes, triage_error: false,
  };
}
