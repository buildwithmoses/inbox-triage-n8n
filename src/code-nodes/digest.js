// Inlined into the "Build digest" Code node. One item in -> per email; one item out -> the morning digest.

export function buildDigest(results, meta = {}) {
  const by = (c) => results.filter((r) => r.category === c && !r.suspicious);
  const needs = by('needs_reply').sort((a, b) => Number(b.urgent) - Number(a.urgent));
  const reading = by('worth_reading');
  const ignore = by('ignore');
  const flagged = results.filter((r) => r.suspicious);
  const line = (r) => `- ${r.urgent ? '⏰ ' : ''}${r.from} — ${r.subject} _(${r.id})_\n  ${r.reason}`;

  const parts = [`**📥 Inbox triage — ${results.length} unread**`];
  if (needs.length) parts.push(`**🔴 Needs a reply (${needs.length})**\n` + needs.map((r) => line(r) + (r.draft_reply ? `\n  _Draft:_ ${r.draft_reply.replace(/\n+/g, ' ')}` : '')).join('\n'));
  if (reading.length) parts.push(`**🟡 Worth reading (${reading.length})**\n` + reading.map(line).join('\n'));
  if (flagged.length) parts.push(`**🚩 Suspicious, do not act (${flagged.length})**\n` + flagged.map((r) => `${line(r)}\n  Flags: ${r.suspicious_reasons.join(', ')}`).join('\n'));
  if (ignore.length) parts.push(`**⚪ Ignore (${ignore.length})**\n` + ignore.map((r) => `- ${r.from} — ${r.subject}`).join('\n'));

  const drafts = results.filter((r) => r.can_send).map((r) => ({ id: r.id, to: r.reply_to, subject: r.subject.startsWith('Re:') ? r.subject : `Re: ${r.subject}`, draft: r.draft_reply, urgent: r.urgent, thread_id: r.thread_id, source: r.source }));
  if (drafts.length) parts.push(`**✅ ${drafts.length} drafts waiting for approval.** Nothing is sent until a person approves it.`);

  return {
    run_at: meta.runAt ?? new Date().toISOString(),
    source: results[0]?.source ?? 'unknown',
    counts: { total: results.length, needs_reply: needs.length, worth_reading: reading.length, ignore: ignore.length, suspicious: flagged.length, drafts: drafts.length },
    digest_markdown: parts.join('\n\n'),
    drafts,
    results,
  };
}
