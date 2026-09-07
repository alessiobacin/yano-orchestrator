import { html } from "htm/preact";

export function Toasts({ toasts }) {
	if (!toasts.length) return null;
	return html`
		<div class="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
			${toasts.map((toast) => html`
				<div key=${toast.id} class=${`rounded-md px-3 py-2 text-sm shadow-lg ${toast.kind === "error" ? "bg-red-600 text-white" : "bg-teal-500 text-slate-900"}`}>${toast.message}</div>
			`)}
		</div>
	`;
}
