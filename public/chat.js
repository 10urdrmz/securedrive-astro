/*
 * Booking messages: polls the thread while the page is open and sends without a
 * reload. The form still works without this script.
 */
(() => {
	for (const box of document.querySelectorAll("[data-chat]")) {
		const list = box.querySelector("[data-chat-list]");
		const form = box.querySelector("[data-chat-form]");
		const field = form?.querySelector("textarea");
		const me = box.dataset.me;
		const L = (key) => box.dataset[`l${key[0].toUpperCase()}${key.slice(1)}`] ?? key;
		let lastKey = "";

		const time = (iso) => new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" });
		const who = (m) => {
			if (m.sender === me) return L("you");
			const role = L(m.sender);
			return m.name && m.sender !== "ops" && m.sender !== "system" ? `${m.name} · ${role}` : role;
		};
		const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
		const toBottom = () => {
			list.scrollTop = list.scrollHeight;
		};

		const render = (messages) => {
			const key = messages.length + ":" + (messages.at(-1)?.id ?? "");
			if (key === lastKey) return;
			const stick = !lastKey || atBottom();
			lastKey = key;
			if (messages.length === 0) {
				list.replaceChildren(Object.assign(document.createElement("li"), { className: "chat-empty", textContent: L("empty") }));
				return;
			}
			list.replaceChildren(
				...messages.map((m) => {
					const li = document.createElement("li");
					// Keep Astro's scoped style attribute so the bubbles stay styled.
					for (const attr of list.attributes) if (attr.name.startsWith("data-astro-cid")) li.setAttribute(attr.name, "");
					li.className = `chat-msg ${m.sender === me ? "mine" : m.sender}`;
					li.dataset.id = m.id;
					const head = document.createElement("span");
					head.className = "chat-who";
					head.textContent = `${who(m)} · ${time(m.at)}`;
					const body = document.createElement("span");
					body.className = "chat-body";
					body.textContent = m.body;
					for (const attr of list.attributes) if (attr.name.startsWith("data-astro-cid")) head.setAttribute(attr.name, ""), body.setAttribute(attr.name, "");
					li.append(head, body);
					return li;
				}),
			);
			if (stick) toBottom();
		};

		const refresh = async () => {
			try {
				const response = await fetch(box.dataset.src, { credentials: "same-origin", cache: "no-store" });
				if (!response.ok) return;
				const data = await response.json();
				render(data.messages ?? []);
			} catch {
				// Offline: the next poll tries again.
			}
		};

		toBottom();
		lastKey = list.querySelectorAll(".chat-msg").length + ":" + (list.querySelector(".chat-msg:last-child")?.dataset.id ?? "");
		setInterval(() => !document.hidden && refresh(), 8000);
		document.addEventListener("visibilitychange", () => !document.hidden && refresh());

		box.querySelectorAll("[data-chat-quick]").forEach((button) =>
			button.addEventListener("click", () => {
				if (!field) return;
				field.value = button.dataset.chatQuick;
				field.focus();
			}),
		);

		form?.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (!field.value.trim()) return;
			const send = form.querySelector("[type=submit]");
			send.disabled = true;
			try {
				const response = await fetch(location.pathname + location.search, { method: "POST", body: new FormData(form), credentials: "same-origin" });
				if (response.ok) field.value = "";
			} catch {
				// Leave the text in the box so nothing is lost.
			}
			send.disabled = false;
			lastKey = "";
			await refresh();
			toBottom();
		});
		field?.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
		});
	}
})();
