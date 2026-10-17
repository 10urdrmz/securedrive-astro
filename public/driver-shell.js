/**
 * Driver app live lists (DriverLayout refresh): every n seconds fetch the page again and
 * swap in the new content and tab counts, without a reload or scroll jump. Waits while
 * the driver types, has a form or menu open, or the app is in the background. The
 * "Canlı" button refreshes at once.
 */
(() => {
	const main = document.querySelector(".drv-main[data-refresh]");
	if (!main) return;
	const every = Math.max(15, Number(main.dataset.refresh) || 60) * 1000;
	const button = document.querySelector("[data-live-refresh]");
	let last = Date.now();
	let running = false;

	const busy = () =>
		document.activeElement?.matches("input, select, textarea") || !!document.querySelector(".drv-main details[open], .drv-menu[open]");

	const refresh = async (force = false) => {
		if (running || document.hidden || (!force && busy())) return;
		running = true;
		button?.classList.add("is-busy");
		try {
			const res = await fetch(location.pathname + location.search, { credentials: "same-origin", headers: { Accept: "text/html" } });
			if (res.redirected) {
				location.href = res.url;
				return;
			}
			if (!res.ok) return;
			const doc = new DOMParser().parseFromString(await res.text(), "text/html");
			const next = doc.querySelector(".drv-main");
			// The driver may have started typing while the page loaded.
			if (next && (force || !busy()) && next.innerHTML !== main.innerHTML) main.innerHTML = next.innerHTML;
			const tabs = document.querySelector(".drv-tabs");
			const nextTabs = doc.querySelector(".drv-tabs");
			if (tabs && nextTabs) tabs.innerHTML = nextTabs.innerHTML;
		} catch {
			// Offline: try again next round.
		} finally {
			last = Date.now();
			running = false;
			button?.classList.remove("is-busy");
		}
	};

	setInterval(() => refresh(), every);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && Date.now() - last > 15_000) refresh();
	});
	button?.addEventListener("click", () => refresh(true));
})();
