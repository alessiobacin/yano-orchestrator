#!/usr/bin/env node

// Unified HTTP/CLI intake for project bugs and suggestions. Unlike the old
// external workers, this process only persists the message and wakes the
// project's planner; the planner owns classification, approval and delegation.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import mqtt from "mqtt";
import { traceRoot } from "./yano-trace-storage.mjs";

const require = createRequire(import.meta.url);
const PORT = 20002;
const TYPES = new Set(["bug", "suggestion"]);
const RESOLUTIONS = new Set(["automatic", "user_confirmation"]);
const STATUSES = new Set(["received", "pending_planner", "queued", "processing", "processed"]);
const MAX_MESSAGE = 20_000;

function sqlite() { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); }
export function dbPath() { return path.join(traceRoot(), "feedback", "feedback.sqlite"); }
export function openDatabase() {
	fs.mkdirSync(path.dirname(dbPath()), { recursive: true, mode: 0o700 });
	const db = new (sqlite().DatabaseSync)(dbPath());
	db.exec(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, type TEXT NOT NULL, project_id TEXT NOT NULL, message TEXT NOT NULL, resolution TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS feedback_project_idx ON feedback(project_id,type,created_at);`);
	return db;
}
function now() { return new Date().toISOString(); }
function id(type) { return `${type === "bug" ? "BUG" : "SUG"}-${crypto.randomUUID()}`; }
function clean(value) { return String(value ?? "").trim().slice(0, MAX_MESSAGE); }
function row(db, feedbackId) { return db.prepare("SELECT * FROM feedback WHERE id=?").get(feedbackId) || null; }
function parseBody(req) { return new Promise((resolve, reject) => { let raw=""; req.on("data", (chunk) => { raw += chunk; if (raw.length > MAX_MESSAGE + 10_000) req.destroy(); }); req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("JSON non valido")); } }); req.on("error", reject); }); }

async function notifyPlanner(item) {
	const client = await mqtt.connectAsync(process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", { connectTimeout: 3_000 });
	try {
	if (process.env.YANO_FEEDBACK_SKIP_NOTIFY === "1") return { delivered: 0, skipped: "test" };
	const scope = item.project_id;
		const statuses = [];
		const onMessage = (_topic, payload) => { try { const card = JSON.parse(payload.toString()); if (card.role === "planner" && card.status !== "offline") statuses.push(card); } catch {} };
		client.on("message", onMessage);
		await client.subscribeAsync(`pi/${scope}/agents/+/status`, { qos: 1 });
		await new Promise((resolve) => setTimeout(resolve, 250));
	for (const planner of statuses) await client.publishAsync(`pi/${scope}/agents/${planner.instance}/commands`, JSON.stringify({ type: "feedback_received", feedback_type: item.type, feedback_id: item.id, project_id: item.project_id, message: item.message, resolution: item.resolution, requires_user_confirmation: item.type === "suggestion" || item.resolution === "user_confirmation" }));
		return { delivered: statuses.length, planners: statuses.map((p) => p.instance) };
	} finally { await client.endAsync(); }
}

export async function createFeedback(db, input) {
	const type = clean(input.type).toLowerCase(); const projectId = clean(input.project_id); const message = clean(input.message);
	if (!TYPES.has(type) || !projectId || !message) throw new Error("type (bug|suggestion), project_id e message sono obbligatori");
	const resolution = type === "bug" ? clean(input.resolution || "user_confirmation") : "user_confirmation";
	if (!RESOLUTIONS.has(resolution)) throw new Error("resolution deve essere automatic oppure user_confirmation");
	const timestamp = now(); const item = { id: id(type), type, project_id: projectId, message, resolution, status: "received", created_at: timestamp, updated_at: timestamp };
	db.prepare("INSERT INTO feedback(id,type,project_id,message,resolution,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(item.id,type,projectId,message,resolution,item.status,timestamp,timestamp);
	const delivery = await notifyPlanner(item).catch((error) => ({ delivered: 0, error: error.message }));
	db.prepare("UPDATE feedback SET status=?,updated_at=? WHERE id=?").run(delivery.delivered ? "queued" : "pending_planner", now(), item.id);
	return { ...row(db, item.id), delivery };
}
function updateFeedback(db, itemId, input) { const current = row(db,itemId); if (!current) return null; const message = input.message === undefined ? current.message : clean(input.message); const resolution = current.type === "suggestion" ? "user_confirmation" : clean(input.resolution || current.resolution); const status = input.status === undefined ? current.status : clean(input.status); if (!message || !RESOLUTIONS.has(resolution) || !STATUSES.has(status)) throw new Error("message, resolution e status devono essere validi"); db.prepare("UPDATE feedback SET message=?,resolution=?,status=?,updated_at=? WHERE id=?").run(message,resolution,status,now(),itemId); return row(db,itemId); }

function json(res, status, body) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
async function api(db, req, res) {
	try {
		const parts = new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean); const method=req.method; const collection=parts[0]; const itemId=parts[1];
		if (method === "GET" && !collection) return json(res,200,{ok:true,service:"yano-feedback",port:PORT});
		if (!TYPES.has(collection === "bugs" ? "bug" : collection === "suggestions" ? "suggestion" : "")) return json(res,404,{error:"endpoint non trovato"});
		const type = collection === "bugs" ? "bug" : "suggestion";
		if (method === "GET" && !itemId) return json(res,200,db.prepare("SELECT * FROM feedback WHERE type=? ORDER BY created_at DESC").all(type));
		if (method === "POST" && !itemId) return json(res,201,await createFeedback(db,{...(await parseBody(req)),type}));
		if (itemId && method === "GET") { const found = row(db,itemId); return json(res,found?200:404,found||{error:"not found"}); }
		if (itemId && (method === "PATCH" || method === "PUT")) { const updated = updateFeedback(db,itemId,await parseBody(req)); return json(res,updated?200:404,updated||{error:"not found"}); }
		if (itemId && method === "DELETE") { const result=db.prepare("DELETE FROM feedback WHERE id=?").run(itemId); return json(res,result.changes?200:404,{deleted:Boolean(result.changes),id:itemId}); }
		return json(res,405,{error:"method non supportato"});
	} catch (error) { return json(res,400,{error:error.message}); }
}

function value(argv, flag) { const i=argv.indexOf(flag); return i>=0?argv[i+1]:null; }
function usage() { return "Uso: yano feedback serve|create|list|get|update|delete [--type bug|suggestion] [--project-id ID] [--message TESTO] [--resolution automatic|user_confirmation] [--status received|pending_planner|queued|processing|processed]"; }
export async function runYanoFeedback({ argv=[] }={}) { const sub=argv[0]; if(!sub||sub==="--help") { console.log(usage()); return; } const db=openDatabase(); try { if(sub==="serve") { const server=http.createServer((req,res)=>api(db,req,res)); const port=Number(value(argv,"--port"))||Number(process.env.YANO_FEEDBACK_API_PORT)||PORT; await new Promise((resolve)=>server.listen(port,"127.0.0.1",()=>{console.log(`yano feedback: API in ascolto su http://127.0.0.1:${port}`); resolve();})); return; } const type=value(argv,"--type"); if(sub==="create") console.log(JSON.stringify(await createFeedback(db,{type,project_id:value(argv,"--project-id"),message:value(argv,"--message"),resolution:value(argv,"--resolution")}),null,2)); else if(sub==="list") console.log(JSON.stringify(db.prepare("SELECT * FROM feedback WHERE type=? ORDER BY created_at DESC").all(type),null,2)); else if(sub==="get") console.log(JSON.stringify(row(db,value(argv,"--id")),null,2)); else if(sub==="update") console.log(JSON.stringify(updateFeedback(db,value(argv,"--id"),{message:value(argv,"--message"),resolution:value(argv,"--resolution"),status:value(argv,"--status")}),null,2)); else if(sub==="delete") { db.prepare("DELETE FROM feedback WHERE id=?").run(value(argv,"--id")); console.log(JSON.stringify({deleted:true,id:value(argv,"--id")},null,2)); } else throw new Error(usage()); } finally { if(sub!=="serve") db.close(); } }
