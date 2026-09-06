const STATUS_RULES = [
	[/await(?:ing|s)?\s+(?:user\s+)?(?:feedback|confirmation)|in attesa di (?:un )?feedback|conferma (?:dell'|utente)/i, "in attesa di feedback utente"],
	[/\bblocked\b|bloccato/i, "blocked"],
	[/\bin progress\b|in corso|lavorando/i, "in progress"],
	[/\bdeployed\b|deploy(?:ed|ment)?|rilasciato/i, "deployed"],
	[/\bcommitted\b|commit (?:creato|eseguito)/i, "committed"],
	[/\bpushed\b|push (?:eseguito|completato)/i, "pushed"],
	[/\bbumped?\b|versione aggiornata|version bump/i, "version bumped"],
	[/\b(?:retry|retrying)\b|nuovo tentativo/i, "retry"],
	[/\bpaused\b|in pausa/i, "paused"],
	[/\b(?:failed|failure|errore)\b/i, "failed"],
	[/\b(?:completed|complete|done|finalized)\b|completato|concluso/i, "completed"],
	[/\b(?:queued|received|processing)\b/i, "processing"],
];

export function inferNotificationStatus(message, explicit = null) {
	if (explicit) return String(explicit);
	for (const [pattern, status] of STATUS_RULES) if (pattern.test(String(message || ""))) return status;
	return "informativo";
}

export function inferNotificationTask(message, explicit = null) {
	if (explicit) return String(explicit);
	const text = String(message || "");
	const match = text.match(/(?:task|ticket|assignment|run)(?:\s+id)?\s*[:=]?\s*["'`]?([^\n"'`]+)/i);
	return match?.[1]?.trim() || "non specificato";
}

export function formatNotification(message, {
	sender = "yano",
	role = "system",
	project = "sconosciuto",
	server = "sconosciuto",
	task = null,
	status = null,
	previousVersion = null,
	currentVersion = null,
	} = {}) {
	const previous = previousVersion || process.env.YANO_PREVIOUS_YANO_VERSION || "n/d";
	const current = currentVersion || process.env.YANO_CURRENT_YANO_VERSION || "n/d";
	return [
		`Mittente: ${sender}${role ? ` (${role})` : ""}`,
		`Progetto: ${project || "sconosciuto"}`,
		`Server: ${server || "sconosciuto"}`,
		`Task: ${inferNotificationTask(message, task)}`,
		`Versione software: precedente ${previous} → attuale ${current}`,
		`Stato: ${inferNotificationStatus(message, status)}`,
		"",
		String(message || "").trim(),
	].join("\n");
}
