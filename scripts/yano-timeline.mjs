// Project-scoped, bounded public projection: no raw transcripts/tool arguments.
import { readTraceRecords, readApplicationHeartbeat } from './yano-trace-storage.mjs';
export function timelineLabel(value) {
  return String(value || '').replace(/(?:Bearer\s+)[\w.\-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|token|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}
export function observedModelFromMessage(message) {
  const text = typeof message?.content === 'string' ? message.content : (Array.isArray(message?.content) ? message.content : []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  const header = text.match(/\[llmp\]\s*provider:\s*([^|\n]+)\|\s*model:\s*([^|\n]+)/);
  return { observed_provider: header?.[1]?.trim() || message?.provider || null, observed_model: header?.[2]?.trim() || message?.model || null, model_source: header ? 'provider_reported_header' : 'message_metadata' };
}
export function projectTimeline(root, { runs = [], now = Date.now(), includeTurns = false } = {}) {
  const types = ['agent_send_out','wake_in','agent_response_in','agent_end','assignment_completed','model_observed',...(includeTurns ? ['assistant_response','turn_start','session_start'] : []),'plan_set','plan_advance'];
  const events = readTraceRecords({ cwd: root, types, limit: 10000 });
  const activity = includeTurns ? readTraceRecords({ cwd: root, types: ['tool_execution_start','tool_execution_end'], since: new Date(now - 86400000), limit: 2000 }) : [];
  const heartbeat = Object.fromEntries([...new Set([...events,...activity].map(e=>e.instance).filter(Boolean))].map(instance=>[instance,readApplicationHeartbeat(root,instance)]));
  return timelineFromEvents([...events,...activity], { runs, now, heartbeat, contextual: includeTurns });
}
export function timelineFromEvents(events, { runs = [], now = Date.now(), heartbeat = {}, contextual = true } = {}) {
  const rounds = new Map(), plans = new Map(), active = new Map(), agents = new Map();
  for (const event of [...events].sort((a,b)=>String(a.ts||'').localeCompare(String(b.ts||'')))) {
    const key = `${event.project_key || event.project || ''}/${event.instance}`;
    if (event.type === 'plan_set') plans.set(event.slug, { slug:event.slug, updated_at:event.ts, phases:structuredClone(event.phases || []) });
    if (event.type === 'plan_advance') for (const phase of plans.get(event.slug)?.phases || []) {
      if (phase.phase === event.completed_phase) phase.status='complete';
      if (phase.phase === event.unlocked_phase) phase.status='unlocked';
    }
    if (event.type === 'session_start') { active.delete(key); agents.set(key,{instance:event.instance,role:event.role,last_activity_at:event.ts,state:'idle'}); continue; }
    let id = event.assignment_id;
    if (event.type === 'turn_start' && !id) id = event.turn_id || (event.had_pending_inbound ? active.get(key) : null) || `turn:${event.instance}:${event.ts}`;
    if (event.type === 'wake_in' || event.type === 'turn_start') active.set(key,id);
    if (contextual && !id && ['model_observed','assistant_response','tool_execution_start','tool_execution_end','agent_end'].includes(event.type)) id=active.get(key);
    if (!id) continue;
    const roundKey = `${event.project_key || event.project || ''}/${id}`;
    let r=rounds.get(roundKey);
    if (!r) {
      r={assignment_id:id,project:event.project||null,instance:null,sender:null,role:null,title:null,started_at:null,ended_at:null,last_activity_at:null,status:'unknown',models:[],routing:[],steps:[],turns:0,phase_id:event.phase_id||null,run_id:event.run_id||null};
      rounds.set(roundKey,r);
    }
    r.title ||= timelineLabel(event.assignment_title || event.prompt_preview) || null;
    if (event.type==='agent_send_out') {r.sender=event.instance;r.instance ||=event.fallback_target||event.target;r.started_at ||=event.ts;if(r.status==='unknown')r.status='dispatched';}
    if (event.type==='wake_in'||event.type==='turn_start') {
      r.instance=event.instance;r.role=event.role;r.sender ||= event.sender_instance;r.started_at ||=event.ts;
      r.status=r.ended_at?r.status:'running';r.turn_open=event.type==='turn_start';
      if(event.type==='turn_start')r.turns++;
      r.last_activity_at=event.ts;
      if(event.model_id)r.routing.push({model:event.model_id,provider:event.model_provider||null});
      agents.set(key,{instance:event.instance,role:event.role,assignment_id:id,last_activity_at:event.ts,state:event.type==='turn_start'?'working':'dispatched'});
    }
    if(event.type==='assistant_response'&&!r.title){
      const summary=String(event.text||'').split('\n').filter(line=>line.trim()&&!/^\s*\[(?:llmp|llmproxy|INTENT)\b/i.test(line))[0] || '';
      r.title=timelineLabel(summary.replace(/[*`#]/g,''))||null;r.title_source='response_summary';
    }
    if (event.type==='model_observed'||event.type==='assistant_response') {
      const m=event.type==='assistant_response'?observedModelFromMessage({content:event.text}):event;
      if(m.model_source==='message_metadata' && /^(llmproxy|auto|default)$/i.test(m.observed_model||'')){r.routing.push({model:m.observed_model,provider:m.observed_provider});continue;}
      if(m.observed_model||m.observed_provider){const model={model:m.model_source==='provider_reported_header'?String(m.observed_model||'').split('|')[0].trim():m.observed_model||null,provider:m.observed_provider||null,source:m.model_source,at:event.ts};if(!r.models.some(x=>x.model===model.model&&x.provider===model.provider))r.models.push(model);}
    }
    if(event.type.startsWith('tool_execution_')) {
      r.last_activity_at=event.ts;
      const step={at:event.ts,tool:timelineLabel(event.tool)||'strumento',state:event.type==='tool_execution_start'?'started':event.ok===false?'failed':'completed'};
      r.steps.push(step);r.steps=r.steps.slice(-12);
      agents.set(key,{instance:event.instance,role:event.role,assignment_id:id,last_activity_at:event.ts,state:step.state==='started'?'working':'between_steps',tool:step.tool});
    }
    if(event.type==='agent_end') {
      r.turn_open=false;r.last_activity_at=event.ts;
      agents.set(key,{instance:event.instance,role:event.role,assignment_id:id,last_activity_at:event.ts,state:'idle'});
      // A direct user turn has no delegated response to wait for.
      if(String(id).startsWith('turn:')){r.ended_at=event.ts;r.status='completed';}
    }
    if(event.type==='agent_response_in'||event.type==='assignment_completed'){
      r.instance=event.responder_instance||r.instance||event.instance;r.ended_at=event.ts;r.status=event.ok===false?'failed':'completed';r.turn_open=false;
    }
  }
  for(const r of rounds.values()) {
    r.title ||= 'Descrizione non registrata';
    const candidates=runs.flatMap(run=>(run.tickets||[]).filter(t=>r.title.includes(t.id)).map(ticket=>({run,ticket})));
    if(candidates.length===1){r.run_id=candidates[0].run.id;r.title=candidates[0].ticket.title;r.ticket_id=candidates[0].ticket.id;}
    r.run_title=runs.find(run=>run.id===r.run_id)?.objective||null;
    r.routing=r.routing.filter((v,i,a)=>a.findIndex(x=>x.model===v.model&&x.provider===v.provider)===i);
    const a=[...agents.values()].find(a=>a.instance===r.instance&&a.assignment_id===r.assignment_id);
    const hb=heartbeat[r.instance];
    r.live=Boolean(!r.ended_at&&['working','between_steps'].includes(a?.state)&&hb?.healthy&&['busy','working'].includes(hb.status));
    r.display_status=r.ended_at?r.status:r.live?'working':now-Date.parse(r.last_activity_at||r.started_at)>90000?'unconfirmed':r.turn_open?'waiting':'awaiting_response';
    r.model_note=r.models.length?null:'Il trace di questo lavoro non contiene il modello effettivo. Il routing configurato, quando presente, è mostrato separatamente.';
  }
  return {rounds:[...rounds.values()].sort((a,b)=>String(a.started_at||'').localeCompare(String(b.started_at||''))),plans:[...plans.values()],agents:[...agents.values()].map(a=>({...a,heartbeat:heartbeat[a.instance]||null})),evidence_limit:10000};
}
