import { html } from "htm/preact";
import { titleOf, dateIt, screenshotSrc, typeIcon } from "../columns.js";

const SEVERITY_COLOR = { low: "#5b7a8c", medium: "#70d6c2", high: "#ff9f43", critical: "#e5484d" };

export function Card({ item, showType, onOpen, onDragStart, onFileDrop }) {
	const shot = screenshotSrc(item);
	return html`
		<article
			class="w-full min-w-0 max-w-full cursor-grab rounded-lg border-l-4 bg-slate-800 p-3 shadow hover:bg-slate-700"
			style=${{ borderLeftColor: SEVERITY_COLOR[item.severity || "medium"] }}
			draggable="true"
			onDragStart=${() => onDragStart()}
			onDragOver=${(event) => { if ([...(event.dataTransfer?.items || [])].some((entry) => entry.kind === "file")) event.preventDefault(); }}
			onDrop=${(event) => { event.preventDefault(); event.stopPropagation(); onFileDrop?.([...event.dataTransfer.files]); }}
			onClick=${() => onOpen(item)}
		>
			${shot ? html`<img class="mb-3 h-28 w-full rounded object-cover" src=${shot} alt="Screenshot allegato" onError=${(event) => event.target.remove()} />` : null}
			<div class="flex items-start justify-between gap-2">
				<b class="min-w-0 flex-1 break-words text-slate-50">${showType ? `${typeIcon(item.type)} ` : ""}${titleOf(item)}</b>
				${item.severity ? html`<span class="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-900" style=${{ background: SEVERITY_COLOR[item.severity] }}>${item.severity}</span>` : null}
			</div>
			<small class="mt-2 block text-slate-400">${item.created_by || "unknown"} · ${dateIt(item.created_at)}</small>
			${item.route ? html`<span class="mt-1 block break-words font-mono text-xs text-slate-400">${item.route}</span>` : null}
		</article>
	`;
}
