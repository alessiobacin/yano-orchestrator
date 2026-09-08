import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { dateIt, screenshotSources, canonicalStatus } from "../columns.js";
import { ActivityIndicator } from "./ActivityIndicator.js";

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
		status: initialStatus || (item ? canonicalStatus(item.status) : "received"),
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
	const [previewScale, setPreviewScale] = useState(1);
	const [screenshots, setScreenshots] = useState(item?.screenshots || []);

	useEffect(() => { setForm(initialForm(item, initialStatus)); setScreenshots(item?.screenshots || []); setPreview(null); setPreviewScale(1); }, [item, initialStatus]);

	function field(name) {
		return { value: form[name], onInput: (event) => setForm({ ...form, [name]: event.target.value }) };
	}

	async function submit(event) {
		event.preventDefault();
		if (!form.message.trim()) return setError("Il messaggio è obbligatorio.");
		if (!form.audit_reason.trim()) return setError("La nota è obbligatoria per ogni modifica.");
		setError(null);
		const payload = { ...form, screenshots };
		if (isNew) delete payload.status;
		try {
			await onSave(payload);
		} catch (saveError) {
			setError(saveError.message);
		}
	}

	const shots = screenshotSources({ ...(item || {}), screenshots });
	const removeScreenshot = (index) => setScreenshots((current) => current.filter((_, position) => position !== index));
	const addFiles = (files) => Promise.all([...files].filter((file) => file.type.startsWith("image/")).slice(0, 8).map((file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ kind: "file", data: reader.result, name: file.name, mime_type: file.type }); reader.onerror = reject; reader.readAsDataURL(file); }))).then((added) => setScreenshots((current) => [...current, ...added]));

	return html`
		<div class="fixed inset-0 z-40 flex justify-end bg-black/60" onClick=${onClose}>
			<form class="flex h-full min-w-0 w-full max-w-md flex-col gap-3 overflow-y-auto bg-slate-900 p-5" onClick=${(event) => event.stopPropagation()} onSubmit=${submit} onDragOver=${(event) => { if ([...(event.dataTransfer?.items || [])].some((entry) => entry.kind === "file")) event.preventDefault(); }} onDrop=${(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
				<div class="flex items-center justify-between">
					<h2 class="text-base font-semibold text-slate-100">${isNew ? "Nuovo" : `Modifica ${item.id}`}</h2>
					<button type="button" class="text-slate-400 hover:text-slate-100" onClick=${onClose}>✕</button>
				</div>

				<label class="text-slate-300">Titolo
					<input placeholder="Esempio: Il campo mostra risultati è tagliato" class="mt-1 w-full min-w-0 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("title")} />
				</label>

				<label class="text-slate-300">Messaggio *
					<textarea placeholder="Descrivi cosa succede, dove e come riprodurlo..." class="mt-1 min-h-[90px] w-full min-w-0 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("message")}></textarea>
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
					<input placeholder="Esempio: /settings/suppliers" class="mt-1 w-full min-w-0 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("route")} />
				</label>

				<label class="text-slate-300">Ambiente
					<input placeholder="Esempio: development, staging o production" class="mt-1 w-full min-w-0 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" ...${field("environment")} />
				</label>

				<section class="rounded-md border border-dashed border-slate-600 p-2" onDragOver=${(event) => event.preventDefault()} onDrop=${(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
					<div class="mb-2 text-xs text-slate-400">Screenshot allegati — trascina qui un’immagine o selezionala</div>
					<input type="file" accept="image/*" multiple onChange=${(event) => addFiles(event.target.files)} />
					<div class="mt-2 grid grid-cols-3 gap-2">
						${shots.map((shot) => html`<div key=${`${shot.src}-${shot._index}`} class="relative"><img class="h-20 w-full cursor-zoom-in rounded object-cover" src=${shot.src} alt=${shot.name || "Screenshot"} onClick=${() => setPreview({ src: shot.src, index: shot._index })} onError=${(event) => { event.currentTarget.style.opacity = "0.25"; }} /><button type="button" class="absolute right-1 top-1 rounded-full bg-red-600 px-1.5 text-white" aria-label="Rimuovi screenshot" onClick=${() => removeScreenshot(shot._index)}>×</button></div>`)}
					</div>
				</section>

				<label class="text-slate-300">Nota *
					<textarea class="mt-1 min-h-[60px] w-full min-w-0 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100" placeholder="Esempio: correggo lo stato dopo aver verificato il bug" ...${field("audit_reason")}></textarea>
				</label>
				${item?.execution ? html`<${ActivityIndicator} execution=${item.execution} />` : null}

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
				<div class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-5" onClick=${() => setPreview(null)}>
					<div class="flex gap-2"><button type="button" class="rounded bg-slate-700 px-3 py-1 text-white" onClick=${(event) => { event.stopPropagation(); setPreviewScale((value) => Math.max(0.5, value - 0.25)); }}>−</button><button type="button" class="rounded bg-slate-700 px-3 py-1 text-white" onClick=${(event) => { event.stopPropagation(); setPreviewScale(1); }}>Reset</button><button type="button" class="rounded bg-slate-700 px-3 py-1 text-white" onClick=${(event) => { event.stopPropagation(); setPreviewScale((value) => Math.min(4, value + 0.25)); }}>+</button></div>
					<div class="max-h-full max-w-full overflow-auto" onClick=${(event) => event.stopPropagation()}><img class="max-h-[78vh] max-w-[90vw] origin-center object-contain" style=${{ transform: `scale(${previewScale})` }} src=${preview.src} alt="Anteprima" /></div>
				</div>
			` : null}
		</div>
	`;
}
