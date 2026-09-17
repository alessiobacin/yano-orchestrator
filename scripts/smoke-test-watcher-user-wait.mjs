import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'yano-user-wait-'));
process.env.YANO_DATA_DIR=path.join(root,'data');process.env.YANO_CONFIG_FILE=path.join(root,'config.env');
const {saveUserWait,projectUserWait,unansweredUserQuestion}=await import('./watcher/user-wait.mjs');
const {ensureRegisteredPlanner,reconcileProjectRun}=await import('./yano-watcher-registry.mjs');
const {runWatch}=await import('./watch-stalls.mjs');
const {projectDbPath}=await import('./yano-project.mjs');
const {DatabaseSync}=await import('node:sqlite');
try {
 const assistant=text=>({type:'message',id:'question-1',message:{role:'assistant',content:[{type:'text',text}]}});
 const question=unansweredUserQuestion([assistant('Confermi il piano?')]);assert.equal(question.question_id,'question-1');
 assert.equal(unansweredUserQuestion([assistant('Confermi?'),{type:'message',message:{role:'user',content:'Sì'}}]),null);
 assert.equal(unansweredUserQuestion([assistant('Attendo il reviewer, sta lavorando.')]),null);
 assert.equal(unansweredUserQuestion([assistant('Eseguo i test adesso.')]),null);
 fs.mkdirSync(path.dirname(projectDbPath(root)),{recursive:true});const db=new DatabaseSync(projectDbPath(root));
 db.exec(`CREATE TABLE runs(id TEXT,project TEXT,objective TEXT,status TEXT,finalization_status TEXT,updated_at TEXT);
 CREATE TABLE events(run_id TEXT,created_at TEXT);CREATE TABLE decision_holds(id TEXT,run_id TEXT,status TEXT);
 CREATE TABLE tickets(id TEXT,run_id TEXT,title TEXT,status TEXT,assigned_instance TEXT,required_playbook TEXT,updated_at TEXT);
 CREATE TABLE ticket_dependencies(ticket_id TEXT,depends_on_id TEXT);CREATE TABLE playbook_bindings(run_id TEXT,playbook_id TEXT,checksum TEXT,snapshot TEXT);
 CREATE TABLE playbook_runtime_state(run_id TEXT,state_id TEXT,generation INTEGER,updated_at TEXT);
 INSERT INTO runs VALUES('run-1','test','Task','active','not_started','2026-01-01');
 INSERT INTO tickets VALUES('ticket-1','run-1','Ready task','pending',NULL,NULL,'2026-01-01');`);
 const row={root,name:'test',project_key:'test'};const snapshot={workspaces:[],panes:[],agents:[],tabs:[]};
 saveUserWait(root,'planner-01',question);
 for(let i=0;i<3;i++) {
  assert.equal(ensureRegisteredPlanner(row,snapshot).recovery,'waiting_for_user','never restart a missing planner to ask whether a human replied');
  assert.equal((await reconcileProjectRun(null,row,snapshot,{get(){throw new Error('MQTT wake forbidden');}})).recovery,'waiting_for_user');
  const scan=await runWatch({cwd:root,argv:['--once']});assert.equal(scan.llm_wakeups,0);
 }
 assert.equal(projectUserWait(path.join(root,'other')).waiting,false,'root isolation');
 saveUserWait(root,'planner-01',null);assert.equal(projectUserWait(root).waiting,false,'user input releases observational wait');
 db.exec("INSERT INTO decision_holds VALUES('hold-1','run-1','open')");
 assert.equal(ensureRegisteredPlanner(row,snapshot).recovery,'waiting_for_user','holds work even with tracing off/no marker');
 assert.equal((await reconcileProjectRun(null,row,snapshot)).recovery,'waiting_for_user');
 db.close();
 assert.equal(projectUserWait(root,[{id:'held',status:'active',open_holds:1},{id:'other',status:'active',open_holds:0}]).waiting,false,'one held run does not suspend unrelated runs');
 console.log('watcher-user-wait: repeated scans skip planner/MQTT, persisted question, reply, holds, project isolation passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
