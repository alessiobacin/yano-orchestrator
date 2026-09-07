async function requestJson(url, options) {
	const response = await fetch(url, options);
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || `richiesta fallita (${response.status})`);
	return body;
}

export function listItems(project, type) {
	const collection = type === "bug" ? "bugs" : "suggestions";
	return requestJson(`/${encodeURIComponent(project)}/${collection}`);
}

export function listProjects() {
	return requestJson("/api/projects");
}

export function createItem(project, type, payload) {
	const collection = type === "bug" ? "bugs" : "suggestions";
	return requestJson(`/${encodeURIComponent(project)}/${collection}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-yano-user": payload.created_by || "local-user" },
		body: JSON.stringify(payload),
	});
}

export function updateItem(project, type, id, payload) {
	const collection = type === "bug" ? "bugs" : "suggestions";
	return requestJson(`/${encodeURIComponent(project)}/${collection}/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "content-type": "application/json", "x-yano-user": payload.updated_by || "local-user" },
		body: JSON.stringify(payload),
	});
}

export function getItem(project, type, id) {
	const collection = type === "bug" ? "bugs" : "suggestions";
	return requestJson(`/${encodeURIComponent(project)}/${collection}/${encodeURIComponent(id)}`);
}

export function subscribeStream(onChange) {
	const source = new EventSource("/api/stream");
	source.onmessage = () => onChange();
	source.onerror = () => {};
	return () => source.close();
}
