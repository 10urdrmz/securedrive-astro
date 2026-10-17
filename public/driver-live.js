/**
 * Driver job screen: polls /surucu/durum.json every 4 seconds and reloads the page when
 * ops or the passenger change the job, so the driver never acts on a stale screen. A full
 * reload keeps location sharing and the chat working; it waits while the driver is typing.
 * Step buttons stay plain form posts.
 */
(() => {
	const code = document.querySelector(".head .code")?.textContent.trim().toUpperCase() ?? "";
	if (!code) return;

	const versionInput = document.querySelector('input[name="version"]');
	let seen = versionInput ? Number(versionInput.value) : null;
	let pending = false;
	const typing = () => !!document.querySelector("textarea:focus, input:focus, select:focus");

	const poll = async () => {
		if (document.hidden) return;
		if (pending) {
			if (!typing()) location.reload();
			return;
		}
		try {
			const res = await fetch(`/surucu/durum.json?code=${encodeURIComponent(code)}`, { cache: "no-store" });
			if (!res.ok) return;
			const data = await res.json();
			if (typeof data.version !== "number") return;
			if (seen === null) seen = data.version;
			else if (data.version !== seen) {
				pending = true;
				if (!typing()) location.reload();
			}
		} catch {
			// Offline for a moment; try again on the next tick.
		}
	};

	setInterval(poll, 4000);
	window.addEventListener("focus", poll);
})();
