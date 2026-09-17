// Durable control state, independent of trace capture and LLM calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tracePaths } from '../yano-trace-storage.mjs';
const directory = root => path.join(tracePaths({cwd:root}).projectDir, 'user-wait');
const file = (root, instance) => path.join(directory(root), `${crypto.createHash('sha256').update(instance).digest('hex').slice(0,24)}.json`);
export function unansweredUserQuestion(branch = []) {
  const messages = branch.filter(e => e?.type === 'message' && ['user','assistant'].includes(e.message?.role));
  const last = messages.at(-1);
  if (last?.message.role !== 'assistant' || last.message.errorMessage) return null;
  const content = last.message.content;
  if (Array.isArray(content) && content.some(p => p.type === 'toolCall')) return null;
  const text = (typeof content === 'string' ? content : (content || []).filter(p=>p.type==='text').map(p=>p.text).join('\n')).replace(/```[\s\S]*?```/g,'').trim();
  // ponytail: conservative Italian/English explicit gates; structured holds cover other wording.
  if (!/\b(?:confermi|approvi|vuoi che|preferisci|mi confermi|puoi (?:indicare|specificare|confermare)|attendo (?:la tua|una tua)|in attesa (?:della tua|di una tua)|please (?:confirm|choose)|do you (?:want|prefer)|waiting for your)\b/i.test(text)) return null;
  return { question_id:last.id || crypto.createHash('sha256').update(text).digest('hex'), asked_at:last.timestamp || new Date().toISOString() };
}
export function saveUserWait(root, instance, question) {
  fs.mkdirSync(directory(root), {recursive:true,mode:0o700});
  const target=file(root,instance), temp=`${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const state={instance,waiting:Boolean(question),...question,updated_at:new Date().toISOString()};
  fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,target);
  return state;
}
export function hasUserWaitState(root, instance) { return fs.existsSync(file(root,instance)); }
export function projectUserWait(root, runs = []) {
  let questions=[];
  try { questions=fs.readdirSync(directory(root)).filter(f=>f.endsWith('.json')).flatMap(f=>{try {const s=JSON.parse(fs.readFileSync(path.join(directory(root),f),'utf8'));return s.waiting?[s]:[];}catch{return [];}}); } catch {}
  const active=runs.filter(r=>r.status==='active'&&!r.paused);
  const held=active.filter(r=>Number(r.open_holds)>0).map(r=>r.id);
  return {waiting:questions.length>0 || (active.length>0 && held.length===active.length),reason:questions.length?'unanswered_user_question':held.length?'open_decision_hold':null,questions,held_run_ids:held};
}
