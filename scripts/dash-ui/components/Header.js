import { html } from "htm/preact";

export function Header({ tab, onTab, projects, project, onProject, search, onSearch, syncedAt, onNew }) {
	return html`
		<header class="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-slate-900 px-6 py-3">
			<h1 class="text-lg font-semibold tracking-wide text-teal-300">Yano Dash</h1>
			<nav class="flex gap-1 rounded-lg bg-slate-800 p-1">
				${["bug", "suggestion", "all"].map((value) => html`
					<button
						key=${value}
						class=${`rounded-md px-3 py-1 text-xs font-medium ${tab === value ? "bg-teal-500 text-slate-900" : "text-slate-300 hover:bg-slate-700"}`}
						onClick=${() => onTab(value)}
					>${value === "bug" ? "🪲 Bug" : value === "suggestion" ? "💡 Suggestion" : "Tutti"}</button>
				`)}
			</nav>
			<input
				class="w-56 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100 placeholder-slate-500"
				placeholder="Cerca titolo, messaggio o route..."
				value=${search}
				onInput=${(event) => onSearch(event.target.value)}
			/>
			<select
				class="rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100"
				value=${project}
				onChange=${(event) => onProject(event.target.value)}
			>
				${projects.map((item) => html`<option key=${item.id} value=${item.id}>${item.name}</option>`)}
			</select>
			<button class="ml-auto rounded-md bg-teal-500 px-3 py-1 font-semibold text-slate-900" onClick=${onNew}>Nuovo</button>
			<span class="text-xs text-slate-500">${syncedAt ? `Aggiornato alle ${syncedAt}` : ""}</span>
		</header>
	`;
}
