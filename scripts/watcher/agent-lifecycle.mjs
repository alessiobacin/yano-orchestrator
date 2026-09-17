// The watcher and status command use this same decision. A ticket is not the
// only unit of work: reviewer assignments must protect a live session too.
export function agentLifecycle({ protectedTab = false, live, status, activeTicket = false, pendingAssignment = false, terminalAge = null, sessionAge = null, freshReplacement = false, evidenceAvailable = true }) {
  if (protectedTab) return { action: 'keep', reason: 'persistent_or_human' };
  if (live === null) return { action: 'keep', reason: 'process_unknown' };
  if (!live) return { action: 'close', reason: 'dead_agent' };
  if (activeTicket || pendingAssignment) return { action: 'keep', reason: activeTicket ? 'active_ticket' : 'pending_assignment' };
  if (!['idle','done','stopped','offline'].includes(status)) return { action: 'keep', reason: 'activity_not_idle' };
  if (!evidenceAvailable) return { action: 'keep', reason: 'work_evidence_unavailable' };
  if (freshReplacement) return { action: 'keep', reason: 'replacement_session' };
  if (terminalAge !== null) return terminalAge >= 30 * 60_000
    ? { action: 'close', reason: 'terminal_task' }
    : { action: 'keep', reason: 'completion_grace', remaining_ms: 30 * 60_000 - terminalAge };
  return sessionAge !== null && sessionAge >= 60 * 60_000
    ? { action: 'close', reason: 'never_ticketed_idle' }
    : { action: 'keep', reason: 'startup_grace' };
}
