import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";
import { Header } from "./components/Header.js";
import { Board } from "./components/Board.js";
import { Drawer } from "./components/Drawer.js";
import { Toasts } from "./components/Toasts.js";
import { listItems, listProjects, createItem, updateItem, getItem, subscribeStream } from "./api.js";
import { columnsForType, canonicalStatus } from "./columns.js";

function App() {
	const [tab, setTab] = useState("bug");
	const [projects, setProjects] = useState([]);
	const [project, setProject] = useState("");
	const [bugs, setBugs] = useState([]);
	const [suggestions, setSuggestions] = useState([]);
	const [search, setSearch] = useState("");
	const [syncedAt, setSyncedAt] = useState(null);
	const [drawer, setDrawer] = useState(undefined);
	const [drawerStatus, setDrawerStatus] = useState(null);
	const [toasts, setToasts] = useState([]);
	const draggedRef = useRef(null);

	function pushToast(message, kind = "info") {
		const id = crypto.randomUUID();
		setToasts((current) => [...current, { id, message, kind }]);
		setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
	}

	async function loadProjects() {
		const list = await listProjects();
		setProjects(list);
		setProject((current) => current || list[0]?.id || "");
	}

	async function loadItems() {
		if (!project) return;
		const [bugList, suggestionList] = await Promise.all([listItems(project, "bug"), listItems(project, "suggestion")]);
		setBugs(bugList);
		setSuggestions(suggestionList);
		setSyncedAt(new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()));
	}

	useEffect(() => { loadProjects(); }, []);
	useEffect(() => { loadItems(); }, [project]);
	useEffect(() => {
		if (!project) return;
		return subscribeStream(loadItems);
	}, [project]);

	const items = useMemo(() => {
		const merged = tab === "bug" ? bugs : tab === "suggestion" ? suggestions : [...bugs, ...suggestions];
		const query = search.trim().toLowerCase();
		if (!query) return merged;
		return merged.filter((item) => [item.title, item.message, item.route].some((value) => String(value || "").toLowerCase().includes(query)));
	}, [tab, bugs, suggestions, search]);

	async function openDrawer(item) {
		try {
			const full = await getItem(project, item.type, item.id);
			setDrawer(full);
			setDrawerStatus(null);
		} catch (error) {
			pushToast(error.message, "error");
		}
	}

	function openNewDrawer() {
		setDrawer(null);
		setDrawerStatus(null);
	}

	function handleDrop(status) {
		const item = draggedRef.current;
		draggedRef.current = null;
		if (!item || canonicalStatus(item.status) === status) return;
		setDrawer(item);
		setDrawerStatus(status);
	}

	async function saveDrawer(payload) {
		if (drawer) {
			await updateItem(project, drawer.type, drawer.id, payload);
			pushToast(`${drawer.id} aggiornato`);
		} else {
			const created = await createItem(project, tab === "suggestion" ? "suggestion" : "bug", payload);
			pushToast(`${created.id} creato`);
		}
		setDrawer(undefined);
		await loadItems();
	}

	return html`
		<div class="flex h-screen flex-col">
			<${Header}
				tab=${tab}
				onTab=${setTab}
				projects=${projects}
				project=${project}
				onProject=${setProject}
				search=${search}
				onSearch=${setSearch}
				syncedAt=${syncedAt}
				onNew=${openNewDrawer}
			/>
			<${Board}
				columns=${columnsForType(tab)}
				items=${items}
				showType=${tab === "all"}
				onOpen=${openDrawer}
				onDragStart=${(item) => { draggedRef.current = item; }}
				onDrop=${handleDrop}
			/>
			${drawer !== undefined ? html`
				<${Drawer}
					item=${drawer}
					defaultType=${tab === "suggestion" ? "suggestion" : "bug"}
					initialStatus=${drawerStatus}
					onClose=${() => setDrawer(undefined)}
					onSave=${saveDrawer}
				/>
			` : null}
			<${Toasts} toasts=${toasts} />
		</div>
	`;
}

render(html`<${App} />`, document.getElementById("root"));
