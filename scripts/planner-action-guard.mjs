import crypto from "node:crypto";

const ACTION_CLAIM_PATTERNS = [
	/\b(?:ora|adesso)\s+(?:il|lo|la)\s+(?:reviewer|coder|revisore|revisione|ticket|prossimo passo)\b/i,
	/\b(?:ora|adesso|subito|a questo punto)\s+(?:lancio|eseguo|avvio|controllo|verifico|provo|invio|chiamo|testo)\b/i,
	/\b(?:lancerò|eseguirò|avvierò|controllerò|verificherò|proverò|invierò|chiamerò|testerò)\b/i,
	/\b(?:procedo|passo)\s+(?:ora\s+)?a\s+(?:lanciare|eseguire|avviare|controllare|verificare|provare|inviare|chiamare)\b/i,
	/\b(?:now|next|immediately)\s+(?:i\s+will\s+)?(?:run|launch|execute|start|check|verify|test|send|call)\b/i,
	/\b(?:i['’]?ll|i will)\s+(?:run|launch|execute|start|check|verify|test|send|call)\b/i,
];

const EXPLICIT_GATE = /(?:\?|\b(?:confermi|approvi|serve\s+(?:la\s+)?approvazione|in\s+attesa|attendo|dopo\s+(?:la\s+)?(?:tua\s+)?conferma|solo\s+dopo\s+(?:la\s+)?(?:tua\s+)?approvazione)\b)/i;

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("\n");
}

function assistantMessages(branch) {
	return (Array.isArray(branch) ? branch : []).filter((entry) =>
		entry?.type === "message" && entry?.message?.role === "assistant",
	);
}

function hasToolCall(entry) {
	return Array.isArray(entry?.message?.content) && entry.message.content.some((part) => part?.type === "toolCall");
}

/**
 * Finds the latest planner response that says it is about to execute an
 * operation but contains no tool call. This is deliberately a narrow,
 * deterministic liveness signal: a proposal waiting for an explicit human
 * confirmation is not considered a missed action.
 */
export function findUnexecutedActionClaim(branch) {
	const latest = assistantMessages(branch).at(-1);
	if (!latest || hasToolCall(latest)) return null;
	const text = contentText(latest.message.content).trim();
	if (!text || EXPLICIT_GATE.test(text)) return null;
	const match = ACTION_CLAIM_PATTERNS.map((pattern) => text.match(pattern)).find(Boolean);
	if (!match) {
		// A ready queue with no subsequent dispatch is actionable state even
		// when the model does not phrase its promise using a recognised verb.
		const entries = Array.isArray(branch) ? branch : [];
		const lastUser = entries.findLastIndex((entry) => entry?.message?.role === "user");
		const recent = entries.slice(lastUser + 1);
		const readyIndex = recent.findLastIndex((entry) => entry?.message?.role === "toolResult" && entry.message.toolName === "tickets_ready");
		const ready = readyIndex >= 0 ? recent[readyIndex].message.details?.ready : null;
		const dispatched = recent.slice(readyIndex + 1).some((entry) => entry?.message?.role === "toolResult" && ["agent_send", "decision_hold_create", "ticket_claim", "ticket_complete"].includes(entry.message.toolName));
		if (!Array.isArray(ready) || !ready.length || dispatched) return null;
		return { claim: "ready tickets without dispatch", fingerprint: crypto.createHash("sha256").update(JSON.stringify(ready)).digest("hex"), text };
	}
	return {
		claim: match[0],
		fingerprint: crypto.createHash("sha256").update(text).digest("hex"),
		text,
	};
}

export function buildPlannerActionGuardPrompt(claim) {
	const safeClaim = String(claim || "azione operativa").replace(/\s+/g, " ").slice(0, 180);
	return `[yano-action-guard] Hai dichiarato un'azione operativa ("${safeClaim}") ma l'ultimo messaggio non contiene una tool call. Non considerare l'azione eseguita: eseguila ora con il tool appropriato. Se è bloccata, usa un controllo read-only per dimostrarlo e comunica il blocco senza promettere un'azione futura.`;
}
