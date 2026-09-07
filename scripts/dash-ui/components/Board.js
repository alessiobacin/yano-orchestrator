import { html } from "htm/preact";
import { Card } from "./Card.js";
import { canonicalStatus } from "../columns.js";

export function Board({ columns, items, showType, onOpen, onDragStart, onDrop }) {
	return html`
		<main class="flex flex-1 gap-3 overflow-x-auto p-5">
			${columns.map((status) => {
				const columnItems = items.filter((item) => canonicalStatus(item.status) === status);
				return html`
					<section
						key=${status}
						class="flex min-h-[120px] w-80 flex-none flex-col rounded-lg border border-slate-700 bg-slate-900 p-2"
						onDragOver=${(event) => event.preventDefault()}
						onDrop=${(event) => { event.preventDefault(); onDrop(status); }}
					>
						<h2 class="mb-2 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
							<span>${status.replaceAll("_", " ")}</span>
							<span class="rounded-full bg-slate-700 px-2 py-0.5 text-slate-200">${columnItems.length}</span>
						</h2>
						<div class="flex flex-1 flex-col gap-2 overflow-y-auto">
							${columnItems.length
								? columnItems.map((item) => html`
									<${Card}
										key=${item.id}
										item=${item}
										showType=${showType}
										onOpen=${onOpen}
										onDragStart=${() => onDragStart(item)}
									/>
								`)
								: html`<p class="p-4 text-center text-xs text-slate-500">Nessun elemento</p>`}
						</div>
					</section>
				`;
			})}
		</main>
	`;
}
