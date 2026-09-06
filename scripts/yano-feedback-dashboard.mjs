#!/usr/bin/env node

// Deterministic Kanban dashboard for the shared Yano feedback registry.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { globalDataPath } from "./yano-config.mjs";
import { createFeedback, dbPath, deleteFeedback, getFeedback, listFeedback, openDatabase, updateFeedback } from "./yano-feedback.mjs";
import { projectKey, resolveTraceProject } from "./yano-trace-storage.mjs";

export const DASHBOARD_MODES = Object.freeze({ bug: { label: "bug-dash", logo: "🪲", collection: "bugs", defaultPort: 11000, min: 11000, max: 11999 }, suggestion: { label: "suggest-dash", logo: "💡", collection: "suggestions", defaultPort: 12000, min: 12000, max: 12999 } });
const statePath = (type) => path.join(globalDataPath({ env: process.env }), "dashboards", `${type}.json`);
const value = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] || null; };
const send = (res, status, data, type = "application/json; charset=utf-8") => { res.writeHead(status, { "content-type": type, "cache-control": "no-store" }); res.end(type.startsWith("application/json") ? JSON.stringify(data) : data); };
const body = (req) => new Promise((resolve, reject) => { const chunks = []; let size = 0; req.on("data", (chunk) => { size += chunk.length; if (size > 25 * 1024 * 1024) { reject(new Error("payload troppo grande")); req.destroy(); } else chunks.push(chunk); }); req.on("error", reject); req.on("end", () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("JSON non valido")); } }); });
const writeState = (type, state) => { const file = statePath(type); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); };
const readState = (type) => { try { return JSON.parse(fs.readFileSync(statePath(type), "utf8")); } catch { return null; } };
const esc = (valueToEscape) => String(valueToEscape ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
function projectRootFrom(cwd) { let current = path.resolve(cwd); for (;;) { if (fs.existsSync(path.join(current, "agents")) || fs.existsSync(path.join(current, ".yano")) || fs.existsSync(path.join(current, ".git"))) return current; const parent = path.dirname(current); if (parent === current) return path.resolve(cwd); current = parent; } }
function projectLabels() { try { const file = path.join(globalDataPath({ env: process.env }), "tracing.json"); const data = JSON.parse(fs.readFileSync(file, "utf8")); return new Map(Object.entries(data.projects || {}).map(([id, item]) => [id, item.project || item.name || id])); } catch { return new Map(); } }
function listen(server, mode) { return new Promise((resolve, reject) => { const ports = [mode.defaultPort, ...Array.from({ length: mode.max - mode.min + 1 }, (_, i) => mode.min + i).filter((port) => port !== mode.defaultPort)]; let index = 0; const attempt = () => { const fail = (error) => { server.removeListener("error", fail); if (error.code === "EADDRINUSE" && index < ports.length) return attempt(); reject(error); }; server.once("error", fail); server.listen(ports[index++], "127.0.0.1", () => { server.removeListener("error", fail); resolve(server.address().port); }); }; attempt(); }); }
export function stopFeedbackDashboard(type) { const state = readState(type); if (!state?.pid) return { stopped: false, reason: "not_running" }; try { process.kill(state.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } writeState(type, { ...state, pid: null, stopped_at: new Date().toISOString() }); return { stopped: true, pid: state.pid }; }
export function page(type, defaultProject, displayName) {
	const mode = DASHBOARD_MODES[type];
	// "pending_planner" is the MOST COMMON resting status right after creation
	// (createFeedback() lands there whenever no live planner happened to be
	// subscribed in the ~250ms notify window — essentially always, unless a
	// planner is actively listening at that exact instant) — omitting it here
	// made every freshly filed record invisible on its own board until
	// something else moved it forward.
	const statuses = type === "bug"
		? ["received", "pending_planner", "processing", "awaiting_user_confirmation", "paused", "retry", "resolved", "failed", "cancelled"]
		: ["received", "pending_planner", "processing", "awaiting_user_confirmation", "paused", "retry", "processed", "cancelled"];
	const options = statuses.map((status) => `<option value="${status}">${status.replaceAll("_", " ")}</option>`).join("");
	return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${mode.label}</title><style>
body{margin:0;background:#101820;color:#edf3f7;font:14px system-ui}
header{padding:16px 28px;border-bottom:1px solid #334554;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;background:#131e28}
h1{margin:0;color:#70d6c2;font-size:19px;letter-spacing:.01em}
header .tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#search{width:230px}
#synced{color:#6c8695;font-size:11px;white-space:nowrap}
.board{display:flex;gap:12px;padding:18px 28px;overflow-x:auto;align-items:flex-start}
.column{background:#1b2731;border:1px solid #334554;border-radius:10px;padding:10px;min-height:120px;min-width:320px;flex:0 0 320px;transition:box-shadow .15s,border-color .15s}
.column.drag-over{border-color:#70d6c2;box-shadow:0 0 0 2px #70d6c266 inset}
.column h2{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#9aacba;display:flex;justify-content:space-between;align-items:center;margin:2px 4px 8px}
.count{background:#334554;color:#cfe0e8;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600}
.empty{color:#5b7a8c;font-size:12px;text-align:center;padding:16px 4px;margin:0}
.card{background:#263643;border-left:4px solid #70d6c2;border-radius:7px;padding:10px;margin:8px 0;cursor:grab;box-shadow:0 1px 2px #0004;transition:background .1s,transform .1s}
.card:hover{background:#304453}
.card:active{cursor:grabbing}
.card.dragging{opacity:.4}
.card.sev-low{border-left-color:#5b7a8c}
.card.sev-medium{border-left-color:#70d6c2}
.card.sev-high{border-left-color:#ff9f43}
.card.sev-critical{border-left-color:#e5484d}
.card-top{display:flex;justify-content:space-between;align-items:start;gap:6px}
.chip{display:inline-block;flex:0 0 auto;font-size:10px;text-transform:uppercase;letter-spacing:.03em;padding:2px 6px;border-radius:4px;font-weight:700}
.chip.sev-low{background:#5b7a8c33;color:#a9c0cd}
.chip.sev-medium{background:#70d6c233;color:#8fe9d9}
.chip.sev-high{background:#ff9f4333;color:#ffbb77}
.chip.sev-critical{background:#e5484d33;color:#ff9098}
.card-main{display:flex;flex-direction:column;gap:8px;align-items:stretch;margin-top:8px}
.card-media{display:block;width:100%;max-height:170px;object-fit:cover;border-radius:5px;background:#111820;cursor:zoom-in}
.card b{display:block;color:#fff;overflow-wrap:anywhere}
.card small{display:block;color:#b8c7d0;margin-top:7px}
.card .route{display:block;color:#9aacba;margin-top:4px;overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:12px}
.modal{display:none;position:fixed;inset:0;background:#000b;align-items:center;justify-content:center}
.modal.open{display:flex}
.dialog{background:#1b2731;padding:20px;border-radius:10px;width:min(700px,90vw);max-height:90vh;overflow:auto}
label{display:block;color:#a8bac7;margin:8px 0}
input,textarea,select,button{width:100%;padding:9px;background:#111820;color:#fff;border:1px solid #405363;border-radius:5px;box-sizing:border-box;font:inherit}
input:invalid,textarea:invalid,select:invalid,.invalid{border-color:#e5484d;box-shadow:0 0 0 1px #e5484d}
textarea{min-height:90px}
button{background:#70d6c2;color:#102027;font-weight:bold;cursor:pointer}
.actions{position:sticky;bottom:-20px;display:flex;gap:8px;margin:15px -20px -20px;padding:12px 20px;background:#1b2731;border-top:1px solid #405363}
.actions button{width:auto;flex:1}
.dropzone{border:1px dashed #70d6c2;border-radius:5px;padding:12px;color:#b8c7d0}
.shot-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:8px}
.shot-item{position:relative}
.shot-item img{width:100%;height:90px;object-fit:cover;border-radius:4px}
.shot-item input{margin-top:4px}
.shot-item button{position:absolute;right:3px;top:3px;width:auto;padding:3px 7px}
.preview-image{max-width:90vw;max-height:72vh;object-fit:contain;display:block;margin:auto;transform-origin:center;cursor:grab}
.preview-image.dragging{cursor:grabbing}.preview-tools{display:flex;gap:8px;margin-top:10px}.preview-tools button{width:auto;flex:1}
</style></head><body>
<header><h1 title="${mode.label}" aria-label="${mode.label}">${mode.logo} <span class="sr-only">${mode.label}</span></h1><div class="tools"><input id="search" placeholder="Cerca titolo, messaggio o route..."><span id="synced"></span>Progetto: <select id="project"></select> <button id="new">Nuovo</button></div></header>
<main id="board" class="board"></main>
<div id="modal" class="modal"><form id="form" class="dialog"><h2 id="title">Nuovo</h2><label>Titolo<input name="title" placeholder="Esempio: Permettere aggiunta fornitore"></label><label>Messaggio *<textarea name="message" required placeholder="Esempio: il pulsante Salva non produce alcun risultato"></textarea></label><label>Stato *<select name="status" required>${options}</select></label><label>Severità<select name="severity"><option>low</option><option selected>medium</option><option>high</option><option>critical</option></select></label><label>Route<input name="route" placeholder="Esempio: /settings/haccp"></label><label>Ambiente<input name="environment" placeholder="Esempio: development o production"></label><label>Screenshot da file<div id="dropzone" class="dropzone">Trascina qui immagini oppure selezionale<input name="screenshot_file" type="file" accept="image/*" multiple></div></label><label>Screenshot URL<div id="url-list" class="shot-list"></div><button type="button" id="add-url">+ Aggiungi URL</button></label><label>Nota *<textarea name="audit_reason" required placeholder="Esempio: spostamento manuale da Received a Processing per iniziare il triage"></textarea></label><div class="actions"><button type="button" id="close">Annulla</button><button type="submit">Salva</button></div></form></div><div id="preview" class="modal" role="dialog" aria-modal="true" aria-label="Anteprima screenshot"><div class="dialog"><h2 id="preview-title">Screenshot</h2><img id="preview-image" class="preview-image" alt="Anteprima screenshot"><div class="preview-tools"><button type="button" data-zoom="out">−</button><button type="button" data-zoom="reset">Reset</button><button type="button" data-zoom="in">+</button><button type="button" id="preview-close">Chiudi</button></div></div></div>
<script>
const TYPE=${JSON.stringify(type)},COL=${JSON.stringify(mode.collection)},ST=${JSON.stringify(statuses)},DEFAULT_PROJECT=${JSON.stringify(defaultProject)};
let project=DEFAULT_PROJECT,items=[],editing=null,files=[],previewScale=1,previewX=0,previewY=0,dragOrigin=null;
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(u,o){const r=await fetch(u,o),x=await r.json();if(!r.ok)throw Error(x.error||'errore');return x}
function dateIt(v){try{return new Intl.DateTimeFormat('it-IT',{timeZone:'Europe/Rome',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(v))}catch{return v||''}}
function titleOf(x){return x.title||String(x.message||'').split(/\\n/).find(Boolean)?.replace(/^#+\\s*/, '').slice(0,120)||x.id}
function shot(x){const s=x.screenshots?.[0];if(!s)return '';let src=s.url||s.data||s.preview_url||'';const md=String(src).match(/^!?\\[[^]]*\\]\\(([^)]+)\\)$/);if(md)src=md[1];if(!src&&s.kind==='file'&&s.name)src='/attachments/'+encodeURIComponent(x.id)+'/'+encodeURIComponent(s.name);const visible=/^https?:/i.test(src)||src.startsWith('data:image/')||src.startsWith('/attachments/');return visible?'<img class="card-media" alt="Screenshot allegato" src="'+esc(src)+'" data-preview-src="'+esc(src)+'">':''}
function canonicalStatus(status){return status==='queued'?'pending_planner':status}
function sevClass(x){return 'sev-'+(x.severity||'medium')}
function cardHtml(x){return '<article class="card '+sevClass(x)+'" draggable="true" data-id="'+esc(x.id)+'"><div class="card-top"><b>'+esc(titleOf(x))+'</b>'+(x.severity?'<span class="chip '+sevClass(x)+'">'+esc(x.severity)+'</span>':'')+'</div><div class="card-main">'+shot(x)+'<div><small>'+esc(x.created_by||'unknown')+' · '+esc(dateIt(x.created_at))+'</small><span class="route">'+esc(x.route||'')+'</span></div></div></article>'}
function wireCards(){document.querySelectorAll('.card').forEach(card=>{card.onclick=()=>edit(card.dataset.id);card.ondragstart=e=>{e.dataTransfer.setData('text/plain',card.dataset.id);e.dataTransfer.effectAllowed='move';card.classList.add('dragging')};card.ondragend=()=>card.classList.remove('dragging')})}
function wireColumns(){document.querySelectorAll('.column').forEach(col=>{col.ondragover=e=>{e.preventDefault();col.classList.add('drag-over')};col.ondragleave=()=>col.classList.remove('drag-over');col.ondrop=async e=>{e.preventDefault();col.classList.remove('drag-over');const id=e.dataTransfer.getData('text/plain'),newStatus=col.dataset.status,item=items.find(x=>x.id===id);if(!item||!newStatus||item.status===newStatus)return;await api('/'+encodeURIComponent(project)+'/'+COL+'/'+id,{method:'PUT',headers:{'content-type':'application/json','x-yano-user':localStorage.yanoUser||'local-user'},body:JSON.stringify({status:newStatus,audit_reason:'Spostato in "'+newStatus+'" via drag & drop'})});load()}})}
function render(){const q=($('#search').value||'').trim().toLowerCase();const filtered=q?items.filter(x=>[titleOf(x),x.message,x.route].some(v=>String(v||'').toLowerCase().includes(q))):items;$('#board').innerHTML=ST.map(st=>{const colItems=filtered.filter(x=>x.status===st);return '<section class="column" data-status="'+st+'"><h2><span>'+st.replaceAll('_',' ')+'</span><span class="count">'+colItems.length+'</span></h2>'+(colItems.length?colItems.map(cardHtml).join(''):'<p class="empty">Nessun elemento</p>')+'</section>'}).join('');wireCards();wireColumns()}
function renderShots(){const list=$('#url-list');list.querySelectorAll('[data-file-preview]').forEach(x=>x.remove());files.forEach((file,i)=>{const item=document.createElement('div');item.className='shot-item';item.dataset.filePreview='true';item.innerHTML='<img alt="Anteprima screenshot"><button type="button" data-remove="'+i+'">×</button>';item.querySelector('button').onclick=()=>{files.splice(i,1);renderShots()};const reader=new FileReader();reader.onload=()=>item.querySelector('img').src=reader.result;reader.readAsDataURL(file);list.prepend(item)})}
function cleanUrl(value=''){const match=String(value||'').match(/^!?\\[[^]]*\\]\\(([^)]+)\\)$/);return match?match[1]:String(value||'')}
function addUrl(value=''){value=cleanUrl(value);const item=document.createElement('div');item.className='shot-item';item.innerHTML='<img class="url-preview" alt="Anteprima URL"><input class="shot-url" type="url" placeholder="Esempio: https://staging.example.it/screenshot.png" value="'+esc(value)+'"><button type="button">×</button>';item.querySelector('img').src=value;item.querySelector('input').oninput=e=>item.querySelector('img').src=e.target.value;item.querySelector('button').onclick=()=>item.remove();$('#url-list').append(item)}
async function load(){if(!project)return;items=await api('/'+encodeURIComponent(project)+'/'+COL);render();const s=$('#synced');if(s)s.textContent='Aggiornato alle '+new Intl.DateTimeFormat('it-IT',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date())}
async function init(){const projects=await api('/api/projects');$('#project').innerHTML=projects.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');if(!projects.some(x=>x.id===project))project=projects[0]?.id||'';$('#project').value=project;load()}
function edit(id){editing=id?items.find(x=>x.id===id):null;files=[];const f=$('#form');f.reset();$('#url-list').innerHTML='';$('#title').textContent=editing?'Modifica '+editing.id:'Nuovo';if(editing){for(const k of ['title','message','severity','route','environment','status'])if(f.elements[k])f.elements[k].value=editing[k]||'';(editing.screenshots||[]).forEach(s=>addUrl(s.url||s.path||''))}$('.modal').classList.add('open')}
$('#project').onchange=e=>{project=e.target.value;load()};
$('#new').onclick=()=>edit();
$('#close').onclick=()=>$('.modal').classList.remove('open');
$('#add-url').onclick=()=>addUrl();
$('#search').oninput=()=>render();
const dz=$('#dropzone');
dz.ondragover=e=>{e.preventDefault();dz.classList.add('invalid')};
dz.ondragleave=()=>dz.classList.remove('invalid');
dz.ondrop=e=>{e.preventDefault();dz.classList.remove('invalid');files.push(...[...e.dataTransfer.files].filter(f=>f.type.startsWith('image/')));renderShots()};
$('#form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);if(!f.reportValidity())return;const v=Object.fromEntries(f.entries());v.project_id=project;v.type=TYPE;v.created_by=localStorage.yanoUser||'local-user';files.push(...[...e.target.elements.screenshot_file.files]);v.screenshots=[...await Promise.all(files.map(async file=>({data:await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)}),name:file.name,mime_type:file.type}))),...([...document.querySelectorAll('.shot-url')].map(x=>x.value.trim()).filter(Boolean).map(url=>({url})))];if(!editing)delete v.status;await api('/'+encodeURIComponent(project)+'/'+COL+(editing?'/'+editing.id:''),{method:editing?'PUT':'POST',headers:{'content-type':'application/json','x-yano-user':v.created_by},body:JSON.stringify(v)});$('.modal').classList.remove('open');load()};
// Compatibility overrides: queued remains accepted by the API, but is rendered
// as pending-planner. Dragging always opens the edit dialog so the mandatory
// transition reason is supplied by the operator instead of being fabricated.
function shot(x){const s=x.screenshots?.[0];if(!s)return '';let src=s.url||s.data||s.preview_url||'';const md=String(src).match(/^!?\\[[^]]*\\]\\(([^)]+)\\)$/);if(md)src=md[1];if(!src&&s.kind==='file'&&s.name)src='/attachments/'+encodeURIComponent(x.id)+'/'+encodeURIComponent(s.name);const visible=/^https?:/i.test(src)||src.startsWith('data:image/')||src.startsWith('/attachments/');return visible?'<img class="card-media" alt="Screenshot allegato" src="'+esc(src)+'" data-preview-src="'+esc(src)+'">':''}
function shot(x){const s=x.screenshots?.[0];if(!s)return '';let src=s.url||s.data||s.preview_url||'';const md=String(src).match(/^!?\[[^]]*\]\(([^)]+)\)$/);if(md)src=md[1];if(!src&&s.kind==='file'&&s.name)src='/attachments/'+encodeURIComponent(x.id)+'/'+encodeURIComponent(s.name);const visible=/^https?:/i.test(src)||src.startsWith('data:image/')||src.startsWith('/attachments/');return visible?'<img class="card-media" alt="Screenshot allegato" src="'+esc(src)+'" data-preview-src="'+esc(src)+'">':''}
function openPreview(src,title){previewScale=1;previewX=0;previewY=0;$('#preview-image').src=src;$('#preview-title').textContent=title||'Screenshot';applyPreview();$('#preview').classList.add('open')}
function applyPreview(){$('#preview-image').style.transform='translate('+previewX+'px,'+previewY+'px) scale('+previewScale+')'}
function wireCards(){document.querySelectorAll('.card').forEach(card=>{card.onclick=()=>edit(card.dataset.id);card.querySelectorAll('[data-preview-src]').forEach(img=>img.onclick=e=>{e.stopPropagation();openPreview(img.dataset.previewSrc,'Screenshot di '+card.dataset.id)});card.ondragstart=e=>{e.dataTransfer.setData('text/plain',card.dataset.id);e.dataTransfer.effectAllowed='move';card.classList.add('dragging')};card.ondragend=()=>card.classList.remove('dragging')})}
function wireColumns(){document.querySelectorAll('.column').forEach(col=>{col.ondragover=e=>{e.preventDefault();col.classList.add('drag-over')};col.ondragleave=()=>col.classList.remove('drag-over');col.ondrop=e=>{e.preventDefault();col.classList.remove('drag-over');const id=e.dataTransfer.getData('text/plain'),newStatus=col.dataset.status,item=items.find(x=>x.id===id);if(!item||!newStatus||canonicalStatus(item.status)===newStatus)return;edit(id,newStatus)}})}
function render(){const q=($('#search').value||'').trim().toLowerCase();const filtered=q?items.filter(x=>[titleOf(x),x.message,x.route].some(v=>String(v||'').toLowerCase().includes(q))):items;$('#board').innerHTML=ST.map(st=>{const colItems=filtered.filter(x=>(x.status==='queued'?'pending_planner':x.status)===st);return '<section class="column" data-status="'+st+'"><h2><span>'+st.replaceAll('_',' ')+'</span><span class="count">'+colItems.length+'</span></h2>'+(colItems.length?colItems.map(cardHtml).join(''):'<p class="empty">Nessun elemento</p>')+'</section>'}).join('');wireCards();wireColumns()}
function edit(id,targetStatus=null){editing=id?items.find(x=>x.id===id):null;files=[];const f=$('#form');f.reset();$('#url-list').innerHTML='';$('#title').textContent=editing?'Modifica '+editing.id:'Nuovo';if(editing){for(const k of ['title','message','severity','route','environment','status'])if(f.elements[k])f.elements[k].value=k==='status'?(targetStatus|| (editing.status==='queued'?'pending_planner':editing.status)):(editing[k]||'');(editing.screenshots||[]).forEach(s=>addUrl(s.url||s.preview_url||''))}$('.modal').classList.add('open')}
$('#preview-close').onclick=()=>$('#preview').classList.remove('open');$('[data-zoom="in"]').onclick=()=>{previewScale=Math.min(5,previewScale+.25);applyPreview()};$('[data-zoom="out"]').onclick=()=>{previewScale=Math.max(.25,previewScale-.25);applyPreview()};$('[data-zoom="reset"]').onclick=()=>{previewScale=1;previewX=0;previewY=0;applyPreview()};$('#preview-image').onwheel=e=>{e.preventDefault();previewScale=Math.max(.25,Math.min(5,previewScale+(e.deltaY<0?.15:-.15)));applyPreview()};$('#preview-image').onmousedown=e=>{dragOrigin={x:e.clientX-previewX,y:e.clientY-previewY};$('#preview-image').classList.add('dragging')};window.onmousemove=e=>{if(dragOrigin){previewX=e.clientX-dragOrigin.x;previewY=e.clientY-dragOrigin.y;applyPreview()}};window.onmouseup=()=>{dragOrigin=null;$('#preview-image').classList.remove('dragging')};
init();
setInterval(load,5000);
</script></body></html>`;
}
async function handler(type, db, req, res, defaultProject, displayName) { const mode = DASHBOARD_MODES[type]; const url = new URL(req.url, "http://localhost"); const parts = url.pathname.split("/").filter(Boolean); const rawProject = parts[0]; const project = rawProject === displayName ? defaultProject : rawProject; const collection = parts[1]; const id = parts[2]; if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || (parts.length === 1 && project === defaultProject))) return send(res, 200, page(type, defaultProject, displayName), "text/html; charset=utf-8"); if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, type }); if (req.method === "GET" && url.pathname === "/api/projects") { const labels = projectLabels(); const ids = [...new Set([defaultProject, ...listFeedback(db, { type }).map((item) => item.project_id)].filter(Boolean))]; return send(res, 200, ids.map((idValue) => ({ id: idValue, name: idValue === defaultProject ? displayName : (labels.get(idValue) || idValue) })).sort((a, b) => a.name.localeCompare(b.name))); } if (collection !== mode.collection || !project) return send(res, 404, { error: "endpoint non trovato" }); if (req.method === "GET" && !id) return send(res, 200, listFeedback(db, { type, project_id: project }).reverse()); if (req.method === "POST" && !id) return send(res, 201, await createFeedback(db, { ...(await body(req)), type, project_id: project, require_credentials: false })); if (id && req.method === "GET") { const item = getFeedback(db, id); return send(res, item?.project_id === project ? 200 : 404, item || { error: "not found" }); } if (id && ["PUT", "PATCH"].includes(req.method)) { const item = getFeedback(db, id); if (!item || item.project_id !== project) return send(res, 404, { error: "not found" }); return send(res, 200, await updateFeedback(db, id, { ...(await body(req)), updated_by: req.headers["x-yano-user"] || undefined })); } if (id && req.method === "DELETE") { const item = getFeedback(db, id); if (!item || item.project_id !== project) return send(res, 404, { error: "not found" }); const input = await body(req); return send(res, 200, deleteFeedback(db, id, { actor: req.headers["x-yano-user"] || "local-user", reason: input.reason || input.audit_reason })); } return send(res, 405, { error: "metodo non supportato" }); }
export async function runFeedbackDashboard({ type, argv = [], cwd = process.cwd() }) { const mode = DASHBOARD_MODES[type]; if (!mode) throw new Error("tipo dashboard non valido"); const sub = argv[0] || "start"; if (sub === "stop") { console.log(JSON.stringify(stopFeedbackDashboard(type), null, 2)); return; } if (sub !== "start") throw new Error(`Uso: yano ${mode.label} start|stop`); const root = projectRootFrom(cwd); const displayName = resolveTraceProject(root) || path.basename(root); const explicitProject = value(argv, "--project-id"); const defaultProject = explicitProject || projectKey(root, displayName); const open = !argv.includes("--no-open"); const db = openDatabase(); const server = http.createServer((req, res) => handler(type, db, req, res, defaultProject, displayName).catch((error) => send(res, 400, { error: error.message }))); const port = await listen(server, mode); const state = { type, pid: process.pid, port, url: `http://127.0.0.1:${port}`, project_id: defaultProject, project_name: displayName, project_root: root, started_at: new Date().toISOString() }; writeState(type, state); const dashboardUrl = `${state.url}/${encodeURIComponent(displayName)}/`; console.log(`yano ${mode.label}: ${dashboardUrl}`); if (open) { const opener = process.platform === "darwin" ? ["open", dashboardUrl] : process.platform === "win32" ? ["cmd", "/c", "start", "", dashboardUrl] : ["xdg-open", dashboardUrl]; spawnSync(opener[0], opener.slice(1), { stdio: "ignore" }); } process.once("SIGTERM", () => { server.close(); db.close(); writeState(type, { ...state, pid: null, stopped_at: new Date().toISOString() }); }); }
