// Shared projection of observed assignments/rounds. No prompts or transcripts
// are returned to HTTP clients; missing evidence stays unknown.
import { readTraceRecords } from './yano-trace-storage.mjs';
export function projectTimeline(root) {
  return timelineFromEvents(readTraceRecords({ cwd: root, types: ['agent_send_out', 'wake_in', 'agent_response_in', 'agent_end', 'assignment_completed', 'model_observed', 'plan_set', 'plan_advance'], limit: 10000 }));
}
export function timelineFromEvents(events) {
  const rounds = new Map(), plans = new Map();
  for (const event of events) {
    const id = event.assignment_id;
    if (event.type === 'plan_set') plans.set(event.slug, { slug: event.slug, updated_at: event.ts, phases: event.phases });
    if (event.type === 'plan_advance') {
      const plan = plans.get(event.slug);
      if (plan) for (const phase of plan.phases) {
        if (phase.phase === event.completed_phase) phase.status = 'complete';
        if (phase.phase === event.unlocked_phase) phase.status = 'unlocked';
      }
    }
    if (!id) continue;
    let round = rounds.get(id);
    if (!round) {
      round = { assignment_id: id, instance: null, sender: null, role: null, started_at: null, ended_at: null, status: 'unknown', models: [], phase_id: event.phase_id || null };
      rounds.set(id, round);
    }
    if (event.type === 'agent_send_out') {
      round.sender = event.instance;
      round.instance ||= event.fallback_target || event.target;
      round.started_at ||= event.ts;
      if (round.status === 'unknown') round.status = 'dispatched';
    }
    if (event.type === 'wake_in') {
      round.instance = event.instance; round.role = event.role;
      round.started_at ||= event.ts;
      if (!round.ended_at) round.status = 'running';
    }
    if (event.type === 'model_observed') {
      const model = { model: event.observed_model || null, provider: event.observed_provider || null, source: event.model_source || 'unknown', at: event.ts };
      if (!round.models.some((m) => m.model === model.model && m.provider === model.provider)) round.models.push(model);
    }
    // An agent_end can be followed by a guard wake-up: only delivery of the
    // response closes the assignment, not merely the end of an LLM turn.
    if (event.type === 'agent_response_in' || event.type === 'assignment_completed') {
      round.instance = event.responder_instance || round.instance || event.instance;
      round.ended_at = event.ts; round.status = event.ok === false ? 'failed' : 'completed';
    }
  }
  return { rounds: [...rounds.values()].sort((a,b) => String(a.started_at || '').localeCompare(String(b.started_at || ''))), plans: [...plans.values()], evidence_limit: 10000 };
}
