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
		let lastActivity = Date.now();

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
			if (lastKey) lastActivity = Date.now();
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
		// Poll fast while a conversation is going on, slower once it has gone quiet.
		let timer = null;
		let live = false;
		const schedule = () => {
			clearTimeout(timer);
			if (document.hidden) return;
			const quiet = Date.now() - lastActivity > 3 * 60000;
			// With the live connection up, polling is only a safety net.
			timer = setTimeout(async () => {
				await refresh();
				schedule();
			}, live ? 30000 : quiet ? 8000 : 2500);
		};

		// Live connection: the server says "changed" the moment someone writes.
		let socket = null;
		let retry = 1000;
		let keepAlive = null;
		const connect = () => {
			if (!box.dataset.room || !("WebSocket" in window) || document.hidden || socket) return;
			const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sohbet/ws?room=${box.dataset.room}`;
			let ws;
			try {
				ws = new WebSocket(url);
			} catch {
				return;
			}
			socket = ws;
			ws.addEventListener("open", () => {
				live = true;
				retry = 1000;
				refresh();
				schedule();
				clearInterval(keepAlive);
				keepAlive = setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
			});
			ws.addEventListener("message", (event) => {
				if (event.data === "changed") {
					lastActivity = Date.now();
					refresh();
				}
			});
			ws.addEventListener("close", () => {
				clearInterval(keepAlive);
				if (socket === ws) socket = null;
				const wasLive = live;
				live = false;
				schedule();
				// Reconnect with back-off; give up quietly if the server has no live chat.
				if (!document.hidden && (wasLive || retry < 8000)) setTimeout(connect, retry);
				retry = Math.min(retry * 2, 30000);
			});
		};
		const wake = () => {
			lastActivity = Date.now();
			if (!document.hidden) refresh().then(schedule);
		};
		schedule();
		connect();
		document.addEventListener("visibilitychange", () => {
			if (document.hidden) {
				clearTimeout(timer);
				socket?.close();
			} else {
				retry = 1000;
				wake();
				connect();
			}
		});
		window.addEventListener("focus", wake);
		window.addEventListener("online", () => {
			retry = 1000;
			wake();
			connect();
		});
		field?.addEventListener("input", () => (lastActivity = Date.now()));

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
			const data = new FormData(form);
			const text = field.value.trim();
			send.disabled = true;
			// Show the message at once; the next refresh replaces it with the stored one.
			list.querySelector(".chat-empty")?.remove();
			const draft = document.createElement("li");
			for (const attr of list.attributes) if (attr.name.startsWith("data-astro-cid")) draft.setAttribute(attr.name, "");
			draft.className = "chat-msg mine";
			draft.style.opacity = "0.6";
			const head = document.createElement("span");
			head.className = "chat-who";
			head.textContent = `${L("you")} · ${time(new Date().toISOString())}`;
			const body = document.createElement("span");
			body.className = "chat-body";
			body.textContent = text;
			for (const attr of list.attributes) if (attr.name.startsWith("data-astro-cid")) head.setAttribute(attr.name, ""), body.setAttribute(attr.name, "");
			draft.append(head, body);
			list.append(draft);
			field.value = "";
			toBottom();
			lastActivity = Date.now();
			try {
				const response = await fetch(location.pathname + location.search, { method: "POST", body: data, credentials: "same-origin", redirect: "manual" });
				if (!response.ok && response.type !== "opaqueredirect") throw new Error(String(response.status));
			} catch {
				// Not sent: put the text back so nothing is lost.
				draft.remove();
				if (!field.value) field.value = text;
			}
			send.disabled = false;
			lastKey = "";
			await refresh();
			toBottom();
			schedule();
		});
		field?.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
		});
	}
})();
