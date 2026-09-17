import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { timelineFromEvents } from './yano-timeline.mjs';
import { agentLifecycle } from './watcher/agent-lifecycle.mjs';
import { executeScript, reconcileScheduleCompletions } from './yano-scheduler.mjs';

const events = [
 {type:'agent_send_out',assignment_id:'a',instance:'coder-01',target:'role:reviewer',ts:'2026-09-15T10:00:00Z'},
 {type:'wake_in',assignment_id:'a',instance:'reviewer-01',role:'reviewer',ts:'2026-09-15T10:00:01Z'},
 {type:'agent_end',assignment_id:'a',instance:'reviewer-01',ts:'2026-09-15T10:02:00Z'},
 {type:'model_observed',assignment_id:'a',observed_model:'model-1',observed_provider:'provider-1',model_source:'message_metadata',ts:'2026-09-15T10:02:00Z'},
];
assert.equal(timelineFromEvents(events).rounds[0].status,'running','end of turn is not delivery/completion');
const round=timelineFromEvents([...events,{type:'agent_response_in',assignment_id:'a',responder_instance:'reviewer-01',ok:true,ts:'2026-09-15T10:02:01Z'}]).rounds[0];
assert.equal(round.status,'completed');assert.equal(round.models[0].provider,'provider-1');
assert.equal(round.instance,'reviewer-01');
const idle={live:true,status:'idle',sessionAge:7200000};
assert.equal(agentLifecycle({...idle,pendingAssignment:true}).action,'keep','reviewer without ticket still owns work');
assert.equal(agentLifecycle({...idle,status:'working'}).action,'keep','never close working agents by age');
assert.equal(agentLifecycle({...idle,live:null}).action,'keep','failed process probe is not proof of death');
assert.equal(agentLifecycle({...idle,evidenceAvailable:false}).action,'keep');
assert.equal(agentLifecycle({...idle,terminalAge:1800001}).action,'close');
assert.equal(agentLifecycle({...idle,terminalAge:1000}).reason,'completion_grace');
assert.equal(agentLifecycle({...idle,protectedTab:true,live:false}).action,'keep');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'yano-essential-'));
try {
 const script=path.join(root,'env.cjs');
 fs.writeFileSync(script,`const {spawnSync}=require('node:child_process'); const r=spawnSync('node',['-p','process.env.YANO_JOB_ID'],{encoding:'utf8'}); if(r.status!==0)process.exit(1); process.stdout.write(r.stdout);`);
 const result=executeScript(script,{env:{PATH:'',YANO_JOB_ID:'isolated-job'}});
 assert.equal(result.status,0,'nested node works with cron-empty PATH');
 assert.equal(result.stdout.trim(),'isolated-job','configured job environment reaches nested processes');
} finally {fs.rmSync(root,{recursive:true,force:true});}
const html=fs.readFileSync(new URL('./gantt.html',import.meta.url),'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
console.log('yano-essential: assignment lifecycle, observed models, cron environment and Gantt syntax passed');

const pending = {status:'dispatched_acknowledged',result:{stdout:JSON.stringify({request_id:'schedule-a'})}};
const store = {jobs:[{instances:[pending]}]};
assert.equal(reconcileScheduleCompletions(store,[]),0,'acceptance alone does not complete a scheduled job');
assert.equal(reconcileScheduleCompletions(store,[{assignment_id:'schedule-a',ended_at:'2026-09-15T12:00:00Z',status:'completed'}]),1);
assert.equal(pending.status,'completed');
