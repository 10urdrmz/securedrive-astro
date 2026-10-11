/*
 * Live car map (OpenStreetMap + Leaflet), used by ops and on the passenger's booking
 * page. Markup: <div data-live-map data-src="…json" data-mode="one|many"> with an
 * inner [data-live-map-canvas] and [data-live-map-note]. Texts come from data-* so
 * the page decides the language: data-waiting, data-updated ("{ago}" is replaced),
 * data-ended, data-now, data-min, data-hour.
 */
(() => {
	const boxes = [...document.querySelectorAll("[data-live-map]")];
	if (!boxes.length) return;
	const POLL_MS = 15000;
	const ISTANBUL = [41.015, 28.98];
	// Leaflet 1.9.4, served from our own origin (public/vendor).
	const LEAFLET = "/vendor/leaflet-1.9.4/";

	const style = document.createElement("style");
	style.textContent = `
		[data-live-map-canvas] { height: 320px; border-radius: 12px; z-index: 0; background: #e5e7eb; }
		.sd-car { position: relative; }
		.sd-car__dot { position: absolute; inset: 0; border-radius: 999px; background: #175cd3; border: 3px solid #fff; box-shadow: 0 0 0 2px rgb(23 92 211 / 0.35), 0 2px 6px rgb(0 0 0 / 0.3); }
		.sd-car__dot::after { content: ""; position: absolute; inset: -8px; border-radius: 999px; border: 2px solid rgb(23 92 211 / 0.45); animation: sd-car-pulse 2s ease-out infinite; }
		.sd-car__label { position: absolute; top: 24px; left: 50%; transform: translateX(-50%); white-space: nowrap; padding: 1px 6px; border-radius: 6px; background: #0a2540; color: #fff; font: 600 12px/1.4 system-ui, sans-serif; }
		.sd-car__label:empty { display: none; }
		@keyframes sd-car-pulse { from { transform: scale(0.6); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
		@media (prefers-reduced-motion: reduce) { .sd-car__dot::after { animation: none; } }
	`;
	document.head.append(style);

	const loadLeaflet = () =>
		new Promise((resolve, reject) => {
			if (window.L) return resolve(window.L);
			const css = document.createElement("link");
			css.rel = "stylesheet";
			css.href = `${LEAFLET}leaflet.css`;
			document.head.append(css);
			const script = document.createElement("script");
			script.src = `${LEAFLET}leaflet.js`;
			script.onload = () => resolve(window.L);
			script.onerror = reject;
			document.head.append(script);
		});

	const ago = (box, iso) => {
		const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
		if (seconds < 60) return box.dataset.now || "now";
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) return (box.dataset.min || "{n} min").replace("{n}", minutes);
		return (box.dataset.hour || "{n} h").replace("{n}", Math.round(minutes / 60));
	};

	const carIcon = (L, label) =>
		L.divIcon({
			className: "sd-car",
			html: `<span class="sd-car__dot"></span>${label ? `<span class="sd-car__label"></span>` : ""}`,
			iconSize: [22, 22],
			iconAnchor: [11, 11],
		});

	const start = async (box) => {
		const canvas = box.querySelector("[data-live-map-canvas]");
		const note = box.querySelector("[data-live-map-note]");
		const many = box.dataset.mode === "many";
		const setNote = (text) => {
			if (note) note.textContent = text;
		};
		let L;
		try {
			L = await loadLeaflet();
		} catch {
			setNote(box.dataset.failed || "Map could not be loaded.");
			return;
		}
		const map = L.map(canvas, { scrollWheelZoom: false }).setView(ISTANBUL, 11);
		L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19,
			// OpenStreetMap's tile servers want to know which site asks; ops pages send no referrer by default.
			referrerPolicy: "strict-origin-when-cross-origin",
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
		}).addTo(map);
		const markers = new Map();
		let fitted = false;
		let timer = null;

		const place = (key, car, label, popup) => {
			let entry = markers.get(key);
			if (!entry) {
				const marker = L.marker([car.lat, car.lng], { icon: carIcon(L, label) }).addTo(map);
				const circle = L.circle([car.lat, car.lng], { radius: 0, weight: 1, color: "#175cd3", fillOpacity: 0.08 }).addTo(map);
				entry = { marker, circle };
				markers.set(key, entry);
				if (label) marker.getElement()?.querySelector(".sd-car__label")?.append(label);
			}
			entry.marker.setLatLng([car.lat, car.lng]);
			entry.circle.setLatLng([car.lat, car.lng]).setRadius(Math.min(car.accuracy || 0, 500));
			if (popup) entry.marker.bindPopup(popup);
		};

		const poll = async () => {
			try {
				const response = await fetch(box.dataset.src, { credentials: "same-origin", cache: "no-store" });
				if (!response.ok) return;
				const data = await response.json();
				const cars = many ? data.cars || [] : data.position ? [data.position] : [];
				const keys = new Set();
				for (const car of cars) {
					const key = many ? car.code : "car";
					keys.add(key);
					let popup = null;
					if (many) {
						popup = document.createElement("div");
						const link = Object.assign(document.createElement("a"), { href: `/ops/rezervasyonlar/${encodeURIComponent(car.code)}`, textContent: car.code });
						popup.append(Object.assign(document.createElement("strong"), { textContent: car.driverName }), document.createElement("br"));
						if (car.plate) popup.append(car.plate, " · ");
						popup.append(link, document.createElement("br"), ago(box, car.at));
					}
					place(key, car, many ? car.driverName.split(" ")[0] : "", popup);
				}
				for (const [key, entry] of markers) {
					if (keys.has(key)) continue;
					entry.marker.remove();
					entry.circle.remove();
					markers.delete(key);
				}
				if (cars.length && !fitted) {
					if (cars.length === 1) map.setView([cars[0].lat, cars[0].lng], 15);
					else map.fitBounds(cars.map((c) => [c.lat, c.lng]), { padding: [40, 40] });
					fitted = true;
				} else if (!many && cars.length) {
					map.panTo([cars[0].lat, cars[0].lng]);
				}
				if (!many && data.status && !["driver_en_route", "driver_arrived", "on_board"].includes(data.status)) {
					setNote(box.dataset.ended || "");
					clearInterval(timer);
					return;
				}
				if (many) setNote((box.dataset.count || "{n}").replace("{n}", cars.length));
				else setNote(cars.length ? (box.dataset.updated || "{ago}").replace("{ago}", ago(box, cars[0].at)) : box.dataset.waiting || "");
			} catch {
				// Offline for a moment; the next tick tries again.
			}
		};

		await poll();
		timer = setInterval(poll, POLL_MS);
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden) poll();
		});
	};

	boxes.forEach(start);
})();
