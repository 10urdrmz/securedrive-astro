/**
 * Passenger trip screen: polls /api/yolculuk-durum.json every 4 seconds and reloads the
 * page when the booking moves on (driver assigned, on the way, arrived, ...). A full reload
 * keeps the live map and the chat working; it waits while the passenger is typing.
 */
(() => {
	const code = document.querySelector("[data-booking-code]")?.dataset.bookingCode?.toUpperCase() ?? "";
	const token = new URLSearchParams(location.search).get("t");
	if (!code || !token) return;

	let seen = null;
	let pending = false;
	const typing = () => !!document.querySelector("textarea:focus, input:focus, select:focus");

	const poll = async () => {
		if (document.hidden) return;
		if (pending) {
			if (!typing()) location.reload();
			return;
		}
		try {
			const res = await fetch(`/api/yolculuk-durum.json?code=${encodeURIComponent(code)}&t=${encodeURIComponent(token)}`, { cache: "no-store" });
			if (!res.ok) return;
			const data = await res.json();
			const now = `${data.status}:${data.version}`;
			if (seen === null) seen = now;
			else if (now !== seen) {
				pending = true;
				if (!typing()) location.reload();
			}
		} catch {
			// Offline for a moment; try again on the next tick.
		}
	};

	setInterval(poll, 4000);
	window.addEventListener("focus", poll);
	poll();
})();
