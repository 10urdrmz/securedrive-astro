/**
 * Live Bidding updater for TripView (GetTransfer style):
 * Polls /api/teklifler.json in the background every 4 seconds.
 * When a new offer arrives or the booking state changes, updates the
 * offers list smoothly without a full page reload or scroll jump.
 */
(() => {
	const container = document.querySelector("[data-offers]");
	if (!container) return;

	const code = container.dataset.code;
	const token = container.dataset.token;
	if (!code || !token) return;

	let currentCount = parseInt(container.dataset.count || "0", 10);
	let isUpdating = false;

	async function checkOffers() {
		if (document.hidden || isUpdating) return;

		try {
			const res = await fetch(`/api/teklifler.json?code=${encodeURIComponent(code)}&t=${encodeURIComponent(token)}`, {
				headers: { "Accept": "application/json" }
			});
			if (!res.ok) return;

			const data = await res.json();

			// If the booking transitioned away from bidding (e.g. accepted elsewhere or expired), refresh page
			if (data.status && data.status !== "bidding") {
				window.location.reload();
				return;
			}

			// If offer count changed, seamlessly update the offers container HTML
			if (typeof data.offersCount === "number" && data.offersCount !== currentCount) {
				isUpdating = true;
				currentCount = data.offersCount;
				container.dataset.count = String(currentCount);

				const pageRes = await fetch(window.location.href);
				if (pageRes.ok) {
					const html = await pageRes.text();
					const parser = new DOMParser();
					const doc = parser.parseFromString(html, "text/html");
					const freshOffers = doc.querySelector("[data-offers]");

					if (freshOffers) {
						// Smoothly swap contents
						container.innerHTML = freshOffers.innerHTML;

						// Highlight the new offer items with a subtle pulse
						const items = container.querySelectorAll("li");
						items.forEach((item, index) => {
							item.style.transition = "all 0.4s ease";
							item.style.transform = "scale(0.99)";
							setTimeout(() => {
								item.style.transform = "scale(1)";
							}, 50 + index * 50);
						});

						// Also show a brief floating alert if it's not the initial state
						showToast((container.dataset.countLabel || "{n}").replace("{n}", String(currentCount)));
					}
				}
				isUpdating = false;
			}
		} catch (err) {
			isUpdating = false;
		}
	}

	function showToast(text) {
		let toast = document.getElementById("bidding-toast");
		if (!toast) {
			toast = document.createElement("div");
			toast.id = "bidding-toast";
			toast.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 20px;border-radius:999px;font-size:13px;font-weight:600;box-shadow:0 10px 25px -5px rgba(0,0,0,0.3);z-index:9999;transition:all 0.3s ease;opacity:0;";
			document.body.appendChild(toast);
		}
		toast.textContent = text;
		toast.style.opacity = "1";
		toast.style.bottom = "32px";
		setTimeout(() => {
			toast.style.opacity = "0";
			toast.style.bottom = "24px";
		}, 3500);
	}

	// Poll every 4 seconds
	setInterval(checkOffers, 4000);

	// Also check immediately when window gains focus
	window.addEventListener("focus", checkOffers);
})();
