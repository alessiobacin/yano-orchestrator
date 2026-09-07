import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { dateIt, screenshotSrc } from "../columns.js";

const SHARED_STATUSES = ["received", "processing", "awaiting_user_confirmation", "paused", "retry", "cancelled"];
const BUG_ONLY_STATUSES = ["resolved", "failed"];
const SUGGESTION_ONLY_STATUSES = ["processed"];

function statusesFor(type) {
	return type === "bug" ? [...SHARED_STATUSES, ...BUG_ONLY_STATUSES] : [...SHARED_STATUSES, ...SUGGESTION_ONLY_STATUSES];
}

function initialForm(item, initialStatus) {
	return {
		title: item?.title || "",
		message: item?.message || "",
		status: initialStatus || item?.status || "received",
		severity: item?.severity || "medium",
		route: item?.route || "",
		environment: item?.environment || "",
		audit_reason: "",
	};
}

export function Drawer({ item, defaultType, initialStatus, onClose, onSave }) {
	const isNew = !item;
	const type = item?.type || defaultType;
	const [form, setForm] = useState(initialForm(item, initialStatus));
	const [error, setError] = useState(null);
	const [preview, setPreview] = useState(null);

	useEffect(() => { setForm(initialForm(item, initialStatus)); }, [item, initialStatus]);

	function field(name) {
		return { value: form[name], onInput: (event) => setForm({ ...form, [name]: event.target.value }) };
	}

	async function submit(event) {
		event.preventDefault();
		if (!form.message.trim()) return setError("Il messaggio è obbligatorio.");
		if (!form.audit_reason.trim()) return setError("La nota è obbligatoria per ogni modifica.");
		setError(null);
		const payload = { ...form };
		if (isNew) delete payload.status;
		try {
			await onSave(payload);
		} catch (saveError) {
			setError(saveError.message);
		}
	}

	const shot = item ? screenshotSrc(item) : null;

	return html`
		<div class="fixed inset-0 z-40 flex justify-end bg-black/60" onClick=${onClose}>
			<form class="flex h-full w-full max-w-md flex-col gap-3 overflow-y-auto bg-slate-900 p-5" onClick=${(event) => event.stopPropagation()} onSubmit=${submit}>
				<div class="flex items-center justify-between">
					<h2 class="text-base font-semibold text-slate-100">${isNew ? "Nuovo" : `Modifica ${item.id}`}</h2>
					<button type="button" class="text-slate-400 hover:text-slate-100" onClick=${onClose}>✕</button>
				</div>

				<label class="text-slate-300">Titolo
					<input class="mt-1 w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("title")} />
				</label>

				<label class="text-slate-300">Messaggio *
					<textarea class="mt-1 min-h-[90px] w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("message")}></textarea>
				</label>

				<label class="text-slate-300">Stato *
					<select class="mt-1 w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("status")}>
						${statusesFor(type).map((status) => html`<option key=${status} value=${status}>${status.replaceAll("_", " ")}</option>`)}
					</select>
				</label>

				<label class="text-slate-300">Severità
					<select class="mt-1 w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("severity")}>
						${["low", "medium", "high", "critical"].map((severity) => html`<option key=${severity} value=${severity}>${severity}</option>`)}
					</select>
				</label>

				<label class="text-slate-300">Route
					<input class="mt-1 w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("route")} />
				</label>

				<label class="text-slate-300">Ambiente
					<input class="mt-1 w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("environment")} />
				</label>

				${shot ? html`<img class="max-h-52 w-full cursor-zoom-in rounded-md object-contain" src=${shot} alt="Screenshot" onClick=${() => setPreview(shot)} />` : null}

				<label class="text-slate-300">Nota *
					<textarea class="mt-1 min-h-[60px] w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" placeholder="Motivo della modifica" ...${field("audit_reason")}></textarea>
				</label>

				${error ? html`<p class="rounded-md border border-red-500 bg-red-950 p-2 text-red-200">${error}</p>` : null}

				<div class="sticky bottom-0 -mx-5 mt-auto flex gap-2 border-t border-slate-700 bg-slate-900 px-5 py-3">
					<button type="button" class="flex-1 rounded-md border border-slate-600 py-2 text-slate-200" onClick=${onClose}>Annulla</button>
					<button type="submit" class="flex-1 rounded-md bg-teal-500 py-2 font-semibold text-slate-900">Salva</button>
				</div>

				${!isNew ? html`
					<section>
						<h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Cronologia</h3>
						<ul class="flex flex-col gap-1 text-xs text-slate-400">
							${(item.audit || []).map((entry) => html`
								<li key=${entry.id} class="rounded border border-slate-700 p-2">
									<span class="text-slate-300">${dateIt(entry.created_at)}</span> — <b>${entry.actor}</b>: ${entry.action}
									<div class="text-slate-500">${entry.reason}</div>
								</li>
							`)}
						</ul>
					</section>
				` : null}
			</form>
			${preview ? html`
				<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick=${() => setPreview(null)}>
					<img class="max-h-[85vh] max-w-[90vw] object-contain" src=${preview} alt="Anteprima" />
				</div>
			` : null}
		</div>
	`;
}
