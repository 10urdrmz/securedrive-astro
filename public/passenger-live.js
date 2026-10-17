/**
 * Live Passenger Trip sync (GetTransfer / Uber style):
 * Polls /api/yolculuk-durum.json in the background every 4 seconds.
 * When the driver transitions steps (assigned -> en_route -> arrived -> on_board -> completed),
 * smoothly updates the trip card and steps without a full page reload or scroll interruption.
 */
(() => {
	const headerEl = document.querySelector("header.relative");
	if (!headerEl) return;

	const codeEl = headerEl.querySelector("strong[dir='ltr']");
	const code = codeEl ? codeEl.textContent.trim().toUpperCase() : "";
	if (!code) return;

	const params = new URLSearchParams(window.location.search);
	const token = params.get("t");
	if (!token) return;

	let currentStatus = null;
	let currentVersion = null;
	let isUpdating = false;

	const statusLabels = {
		confirmed: "Rezervasyon Onaylandı",
		assigned: "Sürücü Atandı",
		driver_en_route: "Sürücü Yola Çıktı",
		driver_arrived: "Sürücü Adrese Vardı",
		on_board: "Yolculuk Başladı",
		completed: "Yolculuk Tamamlandı",
		cancelled: "Rezervasyon İptal Edildi"
	};

	function showToast(text, tone = "info") {
		let toast = document.getElementById("passenger-toast");
		if (!toast) {
			toast = document.createElement("div");
			toast.id = "passenger-toast";
			toast.style.cssText = "position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:12px 24px;border-radius:999px;font-size:14px;font-weight:600;box-shadow:0 12px 30px -5px rgba(0,0,0,0.3);z-index:99999;transition:all 0.3s cubic-bezier(0.16, 1, 0.3, 1);opacity:0;";
			document.body.appendChild(toast);
		}
		toast.textContent = text;
		toast.style.background = tone === "success" ? "#15803d" : "#0f172a";
		toast.style.opacity = "1";
		toast.style.top = "30px";
		setTimeout(() => {
			toast.style.opacity = "0";
			toast.style.top = "18px";
		}, 4000);
	}

	async function refreshTripDOM() {
		try {
			const res = await fetch(window.location.href);
			if (!res.ok) return;

			const html = await res.text();
			const parser = new DOMParser();
			const doc = parser.parseFromString(html, "text/html");

			const oldContainer = document.querySelector(".container.max-w-5xl");
			const newContainer = doc.querySelector(".container.max-w-5xl");

			if (oldContainer && newContainer) {
				oldContainer.innerHTML = newContainer.innerHTML;
			}
		} catch (e) {
			console.error("Failed to refresh passenger trip DOM", e);
		}
	}

	async function pollTrip() {
		if (document.hidden || isUpdating) return;

		try {
			const res = await fetch(`/api/yolculuk-durum.json?code=${encodeURIComponent(code)}&t=${encodeURIComponent(token)}`);
			if (!res.ok) return;

			const data = await res.json();
			if (currentVersion === null) {
				currentVersion = data.version;
				currentStatus = data.status;
				return;
			}

			// If version or status changed
			if (data.version !== currentVersion || data.status !== currentStatus) {
				isUpdating = true;
				currentVersion = data.version;
				const prevStatus = currentStatus;
				currentStatus = data.status;

				if (prevStatus !== currentStatus) {
					const label = statusLabels[currentStatus] || currentStatus;
					showToast(`Güncelleme: ${label}`, "success");
				}

				await refreshTripDOM();
				isUpdating = false;
			}
		} catch (err) {
			isUpdating = false;
		}
	}

	// Poll every 4 seconds
	setInterval(pollTrip, 4000);
	window.addEventListener("focus", pollTrip);
})();
