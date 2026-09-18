// Persistent notification-dedup checkpoint (performance-optimization-loop, round 1).
//
// `runWatch` used to re-read the ENTIRE trace history on every pass to answer
// three "was this already routed?" questions:
//   - stall routes (`previouslyRoutedStalls`),
//   - context-compaction routes (`priorContextRoutes`),
//   - last compaction per instance (`lastCompactionByInstance`).
// Those full-history scans dominate a pass (multi-second on GB-sized trees)
// while the answer barely changes between passes. This module persists those
// three sets in `<traces>/<project-key>/notify-checkpoint.json` so steady
// state needs no historical re-read at all.
//
// Equivalence (why the oracle still holds):
//   - First run (no checkpoint) seeds from the exact same full scans as
//     before — bit-identical sets.
//   - Every in-pass route decision updates the same in-memory Sets the old
//     code used; they are persisted at the end of the pass.
//   - Save is load-merge-write (union with the file), so two concurrent
//     passes for one project cannot clobber each other's keys.
//   - Compaction completions are written by OTHER processes (the extension),
//     so they cannot be covered by the checkpoint alone: the watcher merges
//     a cheap since-bound incremental read (mtime-gated, only recent files)
//     on top of the checkpoint before deciding.
// The trace itself is untouched and remains the audit log; the checkpoint is
// a read accelerator only. All I/O is best-effort: a missing/corrupt
// checkpoint falls back to the old full-scan behaviour.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tracePaths } from "../yano-trace-storage.mjs";

const CHECKPOINT_VERSION = 1;
// Stall keys and route fingerprints accumulate ~1 per finding; 20k entries
// is orders of magnitude above any realistic steady state and keeps the file
// in the low MBs. Oldest entries are pruned first (dedup for ancient routes
// falls back to "notify once more", fail-open by design).
const MAX_STALL_KEYS = 20000;
const MAX_CONTEXT_ROUTES = 20000;

export function notifyCheckpointPath({ cwd, project } = {}) {
	return path.join(tracePaths({ cwd: cwd || process.cwd(), project }).projectDir, "notify-checkpoint.json");
}

function asStringArray(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export function loadNotifyCheckpoint({ cwd, project } = {}) {
	try {
		const raw = JSON.parse(fs.readFileSync(notifyCheckpointPath({ cwd, project }), "utf8"));
		if (!raw || raw.version !== CHECKPOINT_VERSION) return null;
		const compactionByInstance = new Map();
		const stored = raw.compaction_by_instance;
		if (stored && typeof stored === "object") {
			for (const [instance, record] of Object.entries(stored)) {
				if (record && typeof record.ts === "string") compactionByInstance.set(instance, record);
			}
		}
		return {
			seeded: raw.seeded === true,
			updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
			stallKeys: new Set(asStringArray(raw.stall_keys)),
			contextRoutes: new Set(asStringArray(raw.context_routes)),
			compactionByInstance,
		};
	} catch {
		return null;
	}
}

export function saveNotifyCheckpoint({ cwd, project, stallKeys, contextRoutes, compactionByInstance, seeded } = {}) {
	const target = notifyCheckpointPath({ cwd, project });
	try {
		// Load-merge-write: concurrent passes union instead of clobbering.
		const current = loadNotifyCheckpoint({ cwd, project });
		const mergedCompactions = {};
		for (const [instance, record] of [
			...(current?.compactionByInstance?.entries() || []),
			...(compactionByInstance?.entries ? compactionByInstance.entries() : []),
		]) {
			if (!record || typeof record.ts !== "string") continue;
			if (!mergedCompactions[instance] || String(record.ts) > String(mergedCompactions[instance].ts)) {
				mergedCompactions[instance] = record;
			}
		}
		const merged = {
			version: CHECKPOINT_VERSION,
			updated_at: new Date().toISOString(),
			seeded: Boolean(seeded || current?.seeded),
			stall_keys: [...new Set([...(current?.stallKeys || []), ...(stallKeys || [])])].slice(-MAX_STALL_KEYS),
			context_routes: [...new Set([...(current?.contextRoutes || []), ...(contextRoutes || [])])].slice(-MAX_CONTEXT_ROUTES),
			compaction_by_instance: mergedCompactions,
		};
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(merged), { mode: 0o600 });
		fs.renameSync(temp, target);
		return true;
	} catch {
		return false;
	}
}
