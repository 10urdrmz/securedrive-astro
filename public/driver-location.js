/*
 * Driver app: shares the phone's position while this trip is live, so ops and the
 * passenger can follow the car. Runs only on a job page marked data-track-code and
 * stops by itself when the server says the trip is over.
 */
(() => {
	const box = document.querySelector("[data-track-code]");
	if (!box || !("geolocation" in navigator)) return;
	const code = box.dataset.trackCode;
	const status = box.querySelector("[data-track-status]");
	const SEND_EVERY_MS = 15000;
	let lastSent = 0;
	let pending = null;
	let watch = null;
	let wakeLock = null;

	const say = (text, tone) => {
		if (!status) return;
		status.textContent = text;
		box.dataset.tone = tone;
	};

	const stop = () => {
		if (watch !== null) navigator.geolocation.clearWatch(watch);
		watch = null;
		wakeLock?.release?.().catch(() => {});
		say("Yolculuk bitti, konum paylaşımı durdu.", "off");
	};

	const send = async (position) => {
		lastSent = Date.now();
		const { latitude, longitude, accuracy, heading, speed } = position.coords;
		try {
			const response = await fetch("/surucu/konum", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code, lat: latitude, lng: longitude, accuracy, heading, speed }),
			});
			if (response.status === 401) return say("Oturum kapanmış. Tekrar giriş yapın.", "error");
			const result = await response.json().catch(() => ({}));
			if (result.track === false) return stop();
			const time = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
			say(`Konumunuz paylaşılıyor · son gönderim ${time}`, "ok");
		} catch {
			say("Bağlantı yok, konum bağlantı gelince gönderilecek.", "warn");
		}
	};

	const onPosition = (position) => {
		pending = position;
		if (Date.now() - lastSent >= SEND_EVERY_MS) send(position);
	};

	const onError = (error) => {
		if (error.code === error.PERMISSION_DENIED) {
			say("Konum izni verilmedi. Telefon ayarlarından bu siteye konum izni verin ki yolcu aracı görebilsin.", "error");
		} else {
			say("Konum alınamıyor. GPS'in açık olduğundan emin olun.", "warn");
		}
	};

	const keepAwake = async () => {
		try {
			wakeLock = await navigator.wakeLock?.request("screen");
		} catch {
			// Not supported or refused: sharing still works while the page is open.
		}
	};

	say("Konum izni isteniyor…", "warn");
	watch = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
	keepAwake();
	// The phone may hold back updates when standing still: resend the latest one now and then.
	setInterval(() => {
		if (watch !== null && pending && Date.now() - lastSent >= SEND_EVERY_MS * 2) send(pending);
	}, SEND_EVERY_MS);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && watch !== null) keepAwake();
	});
})();
