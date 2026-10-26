// Inlined into the "Normalize email" Code node by scripts/build-workflow.mjs.
// Plain JS, no imports: n8n Code nodes can't import local files, and tests import it directly.
// Every trigger (webhook, manual, Gmail, evaluation dataset row) ends up in ONE shape here.

export const MAX_BODY_CHARS = 4000;

// Keep the head AND the tail of long emails. Deadlines hide at the bottom of long threads
// (fixture e01), so a plain .slice(0, N) like the original Trigger.dev task would cut them off.
export function trimBody(text, max = MAX_BODY_CHARS, headOnly = false) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (body.length <= max) return body;
  if (headOnly) return body.slice(0, max);
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return body.slice(0, head) + '\n[... middle of message trimmed ...]\n' + body.slice(-tail);
}

export function parseAddress(from) {
  if (from && typeof from === 'object') {
    const v = Array.isArray(from.value) ? from.value[0] : from;
    return { display: from.text ?? `${v?.name ?? ''} <${v?.address ?? ''}>`.trim(), address: String(v?.address ?? '').toLowerCase() };
  }
  const s = String(from ?? '');
  const m = s.match(/<([^>]+)>/);
  const address = (m ? m[1] : s).trim().toLowerCase();
  return { display: s, address };
}

export function normalizeEmail(raw, source, opts = {}) {
  const r = raw ?? {};
  const { display, address } = parseAddress(r.from ?? r.From ?? r.sender);
  const isGmail = source === 'gmail';
  const body = isGmail ? (r.text ?? r.textPlain ?? r.snippet ?? '') : (r.body ?? r.text ?? r.preview ?? '');
  return {
    id: String(r.id ?? r.email_id ?? ''),
    thread_id: String(r.threadId ?? r.thread_id ?? r.id ?? ''),
    from: display,
    from_address: address,
    from_domain: address.includes('@') ? address.split('@')[1] : '',
    to: typeof r.to === 'object' && r.to ? (r.to.text ?? '') : String(r.to ?? r.To ?? ''),
    subject: String(r.subject ?? r.Subject ?? '(no subject)'),
    received_at: String(r.received_at ?? r.date ?? ''),
    body: trimBody(body, opts.maxChars ?? MAX_BODY_CHARS, opts.headOnly ?? false),
    source,
  };
}
