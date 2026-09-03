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
const STATUSES = new Set(["received", "pending_planner", "queued", "processing", "awaiting_user_confirmation", "processed", "cancelled"]);
const MAX_MESSAGE = 20_000;
const MAX_SCREENSHOTS = 8;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

function sqlite() { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); }
export function dbPath() { return path.join(traceRoot(), "feedback", "feedback.sqlite"); }
export function openDatabase() {
	fs.mkdirSync(path.dirname(dbPath()), { recursive: true, mode: 0o700 });
	const db = new (sqlite().DatabaseSync)(dbPath());
	db.exec(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, type TEXT NOT NULL, project_id TEXT NOT NULL, message TEXT NOT NULL, resolution TEXT, status TEXT NOT NULL, screenshots TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS feedback_project_idx ON feedback(project_id,type,created_at);`);
	try { db.exec("ALTER TABLE feedback ADD COLUMN screenshots TEXT NOT NULL DEFAULT '[]'"); } catch (error) { if (!/duplicate column/i.test(String(error?.message || error))) throw error; }
	return db;
}
function now() { return new Date().toISOString(); }
function id(type) { return `${type === "bug" ? "BUG" : "SUG"}-${crypto.randomUUID()}`; }
function clean(value) { return String(value ?? "").trim().slice(0, MAX_MESSAGE); }
function decodeRow(value) {
	if (!value) return value;
	try { return { ...value, screenshots: JSON.parse(value.screenshots || "[]") }; } catch { return { ...value, screenshots: [] }; }
}
function row(db, feedbackId) { const value = db.prepare("SELECT * FROM feedback WHERE id=?").get(feedbackId); return value ? decodeRow(value) : null; }
export function listFeedback(db, { project_id = null, type = null, statuses = null } = {}) {
	const clauses = []; const args = [];
	if (project_id) { clauses.push("project_id=?"); args.push(project_id); }
	if (type) { clauses.push("type=?"); args.push(type); }
	if (Array.isArray(statuses) && statuses.length) { clauses.push(`status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses); }
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	return db.prepare(`SELECT * FROM feedback ${where} ORDER BY created_at ASC`).all(...args).map(decodeRow);
}
export function claimFeedback(db, feedbackId) {
	const current = row(db, feedbackId);
	if (!current || !["received", "pending_planner", "queued"].includes(current.status)) return current;
	db.prepare("UPDATE feedback SET status='processing',updated_at=? WHERE id=? AND status IN ('received','pending_planner','queued')").run(now(), feedbackId);
	return row(db, feedbackId);
}
function attachmentRoot(feedbackId) { return path.join(path.dirname(dbPath()), "attachments", feedbackId); }
function safeName(name) { return path.basename(String(name || "screenshot" )).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "screenshot"; }
function imageLike(name, mime) { return /^image\//i.test(String(mime || "")) || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(String(name || "")); }
function screenshotInputs(input) {
	if (input === undefined || input === null || input === "") return [];
	if (Array.isArray(input)) return input;
	return [input];
}
function materializeScreenshots(feedbackId, input) {
	const values = screenshotInputs(input).slice(0, MAX_SCREENSHOTS);
	const result = [];
	for (const value of values) {
		const item = typeof value === "string" ? { value } : (value && typeof value === "object" ? value : {});
		const url = String(item.url || (typeof value === "string" && /^https?:\/\//i.test(value) ? value : "")).trim();
		if (url) {
			if (!/^https:\/\//i.test(url) && !/^http:\/\/localhost(?::\d+)?\//i.test(url)) throw new Error("gli screenshot remoti devono usare HTTPS (oppure localhost)");
			result.push({ kind: "url", url, name: safeName(item.name || "remote-screenshot"), mime_type: item.mime_type || null });
			continue;
		}
		const sourcePath = String(item.path || (typeof value === "string" ? value : "")).trim();
		if (sourcePath) {
			const stat = fs.statSync(sourcePath);
			if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`screenshot locale non valido o troppo grande: ${sourcePath}`);
			if (!imageLike(sourcePath, item.mime_type)) throw new Error(`il file non sembra un'immagine: ${sourcePath}`);
			const name = safeName(item.name || sourcePath);
			const dir = attachmentRoot(feedbackId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			const target = path.join(dir, `${String(result.length + 1).padStart(2, "0")}-${name}`);
			fs.copyFileSync(sourcePath, target);
			result.push({ kind: "file", path: target, name, mime_type: item.mime_type || null, bytes: stat.size });
			continue;
		}
		const data = String(item.data || "");
		if (data) {
			const match = data.match(/^data:([^;,]+)?;base64,(.+)$/s);
			const mime = item.mime_type || match?.[1] || "image/png";
			const encoded = match?.[2] || data;
			const buffer = Buffer.from(encoded, "base64");
			const name = safeName(item.name || `screenshot-${result.length + 1}.png`);
			if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES || !imageLike(name, mime)) throw new Error("dati screenshot non validi o troppo grandi");
			const dir = attachmentRoot(feedbackId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			const target = path.join(dir, `${String(result.length + 1).padStart(2, "0")}-${name}`);
			fs.writeFileSync(target, buffer, { mode: 0o600 });
			result.push({ kind: "file", path: target, name, mime_type: mime, bytes: buffer.length });
		}
	}
	return result;
}
function readRequest(req) {
	return new Promise((resolve, reject) => {
		const chunks = []; let size = 0;
		req.on("data", (chunk) => { size += chunk.length; if (size > 50 * 1024 * 1024) { reject(new Error("richiesta troppo grande")); req.destroy(); return; } chunks.push(Buffer.from(chunk)); });
		req.on("error", reject);
		req.on("end", () => {
			const body = Buffer.concat(chunks); const contentType = String(req.headers["content-type"] || "");
			if (!body.length) return resolve({});
			if (!/^multipart\/form-data/i.test(contentType)) { try { return resolve(JSON.parse(body.toString("utf8"))); } catch { return reject(new Error("JSON non valido")); } }
			const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
			if (!boundary) return reject(new Error("multipart boundary mancante"));
			const delimiter = Buffer.from(`--${boundary}`); const output = {}; const files = [];
			let offset = 0;
			while (true) {
				const start = body.indexOf(delimiter, offset); if (start < 0) break;
				const partStart = start + delimiter.length; if (body.slice(partStart, partStart + 2).toString() === "--") break;
				const contentStart = partStart + (body.slice(partStart, partStart + 2).toString() === "\r\n" ? 2 : 0);
				const next = body.indexOf(delimiter, contentStart); if (next < 0) break;
				const part = body.slice(contentStart, next - (body.slice(next - 2, next).toString() === "\r\n" ? 2 : 0));
				const headerEnd = part.indexOf(Buffer.from("\r\n\r\n")); if (headerEnd < 0) { offset = next; continue; }
				const headers = part.slice(0, headerEnd).toString("utf8"); const content = part.slice(headerEnd + 4);
				const disposition = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i); if (!disposition) { offset = next; continue; }
				const name = disposition[1]; const filename = disposition[2]; const mime = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || null;
				if (filename) files.push({ data: `data:${mime || "image/png"};base64,${content.toString("base64")}`, name: filename, mime_type: mime });
				else output[name] = content.toString("utf8");
				offset = next;
			}
			if (files.length) output.screenshots = [...screenshotInputs(output.screenshots).flatMap((v) => { try { return JSON.parse(v); } catch { return [v]; } }), ...files];
			for (const key of ["project_id", "message", "type", "resolution", "status"]) if (typeof output[key] === "string") output[key] = output[key].trim();
			resolve(output);
		});
	});
}

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
	for (const planner of statuses) await client.publishAsync(`pi/${scope}/agents/${planner.instance}/commands`, JSON.stringify({ type: "feedback_received", feedback_type: item.type, feedback_id: item.id, project_id: item.project_id, message: item.message, resolution: item.resolution, screenshots: item.screenshots || [], requires_user_confirmation: item.type === "suggestion" || item.resolution === "user_confirmation" }));
		return { delivered: statuses.length, planners: statuses.map((p) => p.instance) };
	} finally { await client.endAsync(); }
}

export async function createFeedback(db, input) {
	const type = clean(input.type).toLowerCase(); const projectId = clean(input.project_id); const message = clean(input.message);
	if (!TYPES.has(type) || !projectId || !message) throw new Error("type (bug|suggestion), project_id e message sono obbligatori");
	const resolution = type === "bug" ? clean(input.resolution || "user_confirmation") : "user_confirmation";
	if (!RESOLUTIONS.has(resolution)) throw new Error("resolution deve essere automatic oppure user_confirmation");
	const timestamp = now(); const feedbackId = id(type); const item = { id: feedbackId, type, project_id: projectId, message, resolution, status: "received", screenshots: materializeScreenshots(feedbackId, input.screenshots), created_at: timestamp, updated_at: timestamp };
	db.prepare("INSERT INTO feedback(id,type,project_id,message,resolution,status,screenshots,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(item.id,type,projectId,message,resolution,item.status,JSON.stringify(item.screenshots),timestamp,timestamp);
	const delivery = input.notify === false ? { delivered: 0, skipped: "planner_tool" } : await notifyPlanner(item).catch((error) => ({ delivered: 0, error: error.message }));
	db.prepare("UPDATE feedback SET status=?,updated_at=? WHERE id=?").run(delivery.delivered ? "queued" : "pending_planner", now(), item.id);
	return { ...row(db, item.id), delivery };
}
async function updateFeedback(db, itemId, input) { const current = row(db,itemId); if (!current) return null; const message = input.message === undefined ? current.message : clean(input.message); const resolution = current.type === "suggestion" ? "user_confirmation" : clean(input.resolution || current.resolution); const status = input.status === undefined ? current.status : clean(input.status); if (!message || !RESOLUTIONS.has(resolution) || !STATUSES.has(status)) throw new Error("message, resolution e status devono essere validi"); const screenshots = input.screenshots === undefined ? current.screenshots : materializeScreenshots(itemId, input.screenshots); db.prepare("UPDATE feedback SET message=?,resolution=?,status=?,screenshots=?,updated_at=? WHERE id=?").run(message,resolution,status,JSON.stringify(screenshots),now(),itemId); return row(db,itemId); }

function json(res, status, body) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
async function api(db, req, res) {
	try {
		const parts = new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean); const method=req.method; const collection=parts[0]; const itemId=parts[1];
		if (method === "GET" && !collection) return json(res,200,{ok:true,service:"yano-feedback",port:PORT});
		if (!TYPES.has(collection === "bugs" ? "bug" : collection === "suggestions" ? "suggestion" : "")) return json(res,404,{error:"endpoint non trovato"});
		const type = collection === "bugs" ? "bug" : "suggestion";
		if (method === "GET" && !itemId) return json(res,200,listFeedback(db, { type, project_id: new URL(req.url, "http://localhost").searchParams.get("project_id") || null }).reverse());
		if (method === "POST" && !itemId) return json(res,201,await createFeedback(db,{...(await readRequest(req)),type}));
		if (itemId && method === "GET") { const found = row(db,itemId); return json(res,found?200:404,found||{error:"not found"}); }
		if (itemId && (method === "PATCH" || method === "PUT")) { const updated = await updateFeedback(db,itemId,await readRequest(req)); return json(res,updated?200:404,updated||{error:"not found"}); }
		if (itemId && method === "DELETE") { const result=db.prepare("DELETE FROM feedback WHERE id=?").run(itemId); return json(res,result.changes?200:404,{deleted:Boolean(result.changes),id:itemId}); }
		return json(res,405,{error:"method non supportato"});
	} catch (error) { return json(res,400,{error:error.message}); }
}

function value(argv, flag) { const i=argv.indexOf(flag); return i>=0?argv[i+1]:null; }
function values(argv, flag) { const result=[]; for(let i=0;i<argv.length;i++) if(argv[i]===flag && argv[i+1]) result.push(argv[i+1]); return result; }
function usage() { return "Uso: yano feedback serve|create|list|get|update|delete [--type bug|suggestion] [--project-id ID] [--message TESTO] [--screenshot PATH|URL] [--resolution automatic|user_confirmation] [--status received|pending_planner|queued|processing|awaiting_user_confirmation|processed|cancelled]"; }
export async function runYanoFeedback({ argv=[] }={}) { const sub=argv[0]; if(!sub||sub==="--help") { console.log(usage()); return; } const db=openDatabase(); try { if(sub==="serve") { const server=http.createServer((req,res)=>api(db,req,res)); const port=Number(value(argv,"--port"))||Number(process.env.YANO_FEEDBACK_API_PORT)||PORT; await new Promise((resolve)=>server.listen(port,"127.0.0.1",()=>{console.log(`yano feedback: API in ascolto su http://127.0.0.1:${port}`); resolve();})); return; } const type=value(argv,"--type"); if(sub==="create") console.log(JSON.stringify(await createFeedback(db,{type,project_id:value(argv,"--project-id"),message:value(argv,"--message"),resolution:value(argv,"--resolution"),screenshots:values(argv,"--screenshot")}),null,2)); else if(sub==="list") console.log(JSON.stringify(listFeedback(db,{type,project_id:value(argv,"--project-id")}).reverse(),null,2)); else if(sub==="get") console.log(JSON.stringify(row(db,value(argv,"--id")),null,2)); else if(sub==="update") console.log(JSON.stringify(await updateFeedback(db,value(argv,"--id"),{message:value(argv,"--message"),resolution:value(argv,"--resolution"),status:value(argv,"--status"),screenshots:values(argv,"--screenshot").length?values(argv,"--screenshot"):undefined}),null,2)); else if(sub==="delete") { db.prepare("DELETE FROM feedback WHERE id=?").run(value(argv,"--id")); console.log(JSON.stringify({deleted:true,id:value(argv,"--id")},null,2)); } else throw new Error(usage()); } finally { if(sub!=="serve") db.close(); } }
