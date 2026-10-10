/*
 * Ops panel live alerts: keeps the menu counts and the bell current and announces new
 * price requests and web bookings (in-page toast, tab title, optional desktop
 * notification). Polls /ops/bildirim.json; the page works the same without it.
 */
(() => {
	const POLL_MS = 20000;
	const SEEN_KEY = "sdOpsSeenAt";
	const bell = document.querySelector("[data-ops-bell]");
	const list = document.querySelector("[data-ops-feed]");
	const toasts = document.querySelector("[data-ops-toasts]");
	const enable = document.querySelector("[data-ops-enable]");
	if (!bell || !list) return;

	const baseTitle = document.title;
	const read = (key) => {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	};
	const write = (key, value) => {
		try {
			localStorage.setItem(key, value);
		} catch {
			// Private mode: alerts still work for this page view.
		}
	};

	const newestAt = () => list.querySelector("li[data-at]")?.dataset.at ?? "";
	// First visit: what is already there counts as seen.
	if (!read(SEEN_KEY)) write(SEEN_KEY, newestAt() || new Date().toISOString());
	let lastPollNewest = newestAt();

	const markUnread = () => {
		const seen = read(SEEN_KEY) ?? "";
		let unread = 0;
		for (const li of list.querySelectorAll("li[data-at]")) {
			const isNew = li.dataset.at > seen;
			li.classList.toggle("unread", isNew);
			if (isNew) unread++;
		}
		document.title = unread ? `(${unread}) ${baseTitle}` : baseTitle;
	};

	const setCount = (el, n) => {
		el.textContent = String(n);
		el.hidden = n === 0;
	};

	const ago = (iso) => {
		const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
		if (minutes < 1) return "şimdi";
		if (minutes < 60) return `${minutes} dk önce`;
		if (minutes < 1440) return `${Math.floor(minutes / 60)} sa önce`;
		return `${Math.floor(minutes / 1440)} gün önce`;
	};

	const el = (tag, props = {}, children = []) => {
		const node = Object.assign(document.createElement(tag), props);
		for (const child of children) node.append(child);
		return node;
	};

	const renderFeed = (feed) => {
		list.replaceChildren(
			...(feed.length
				? feed.map((item) => {
						const li = el("li");
						li.dataset.key = item.key;
						li.dataset.at = item.at;
						const dot = el("span", { className: `ops-dot ${item.kind}` });
						dot.setAttribute("aria-hidden", "true");
						const time = el("time", { textContent: ago(item.at) });
						time.dateTime = item.at;
						li.append(
							el("a", { href: item.href }, [
								dot,
								el("span", { className: "ops-feed-text" }, [el("strong", { textContent: item.title }), el("span", { textContent: item.detail })]),
								time,
							]),
						);
						return li;
					})
				: [
						el("li", {
							className: "ops-empty",
							textContent: "Henüz bildirim yok.",
						}),
					]),
		);
		markUnread();
	};

	const beep = () => {
		try {
			const ctx = new AudioContext();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.frequency.value = 880;
			gain.gain.setValueAtTime(0.0001, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
			osc.connect(gain).connect(ctx.destination);
			osc.start();
			osc.stop(ctx.currentTime + 0.4);
		} catch {
			// No sound before the user has interacted with the page; the toast still shows.
		}
	};

	const announce = (item) => {
		if (toasts) {
			const toast = el("a", { className: `ops-toast ${item.kind}`, href: item.href }, [
				el("span", { className: `ops-dot ${item.kind}` }),
				el("div", {}, [el("strong", { textContent: item.title }), el("br"), el("span", { textContent: item.detail })]),
			]);
			toasts.append(toast);
			setTimeout(() => toast.remove(), 12000);
		}
		if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
			const n = new Notification(item.title, {
				body: item.detail,
				tag: item.key,
				icon: "/favicon.svg",
			});
			n.onclick = () => {
				window.focus();
				location.href = item.href;
			};
		}
	};

	const poll = async () => {
		try {
			const response = await fetch("/ops/bildirim.json", {
				credentials: "same-origin",
				cache: "no-store",
			});
			if (!response.ok) return;
			const { counts, feed } = await response.json();
			for (const node of document.querySelectorAll("[data-ops-count]")) setCount(node, counts[node.dataset.opsCount] ?? 0);
			const total = document.querySelector("[data-ops-total]");
			if (total) setCount(total, (counts.requests ?? 0) + (counts.bookings ?? 0));
			const fresh = feed.filter((item) => item.at > lastPollNewest).reverse();
			if (feed[0]) lastPollNewest = feed[0].at > lastPollNewest ? feed[0].at : lastPollNewest;
			renderFeed(feed);
			if (fresh.length) {
				fresh.slice(-3).forEach(announce);
				beep();
				bell.classList.remove("ring");
				void bell.offsetWidth;
				bell.classList.add("ring");
			}
		} catch {
			// Offline for a moment; try again on the next tick.
		}
	};

	bell.addEventListener("toggle", () => {
		if (!bell.open) return;
		write(SEEN_KEY, newestAt() || new Date().toISOString());
		setTimeout(markUnread, 1500);
	});
	document.addEventListener("click", (event) => {
		if (bell.open && !bell.contains(event.target)) bell.open = false;
	});

	if (enable && "Notification" in window && Notification.permission === "default") {
		enable.hidden = false;
		enable.addEventListener("click", async () => {
			const result = await Notification.requestPermission();
			if (result !== "default") enable.hidden = true;
		});
	}

	markUnread();
	setInterval(poll, POLL_MS);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) poll();
	});
})();
