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
		showHelp(false);
		pending = position;
		if (Date.now() - lastSent >= SEND_EVERY_MS) send(position);
	};

	const help = box.querySelector("[data-track-help]");
	const retry = box.querySelector("[data-track-retry]");
	const ua = navigator.userAgent;
	const iphone = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
	const iosApp = /CriOS/.test(ua) ? "Chrome" : /FxiOS/.test(ua) ? "Firefox" : /EdgiOS/.test(ua) ? "Edge" : "Safari";
	// Where the switch is on the driver's own phone, step by step.
	const steps = iphone
		? [
				"Sayfayı WhatsApp içinden açtıysanız önce Safari'de açın (sağ alttaki pusula simgesi).",
				"Ayarlar → Gizlilik ve Güvenlik → Konum Servisleri'ni açın.",
				iosApp === "Safari"
					? "Aynı sayfanın altında Safari Web Siteleri → \"Uygulamayı Kullanırken\" seçin, Kesin Konum'u açın."
					: `Aynı sayfada ${iosApp} → "Uygulamayı Kullanırken" seçin, Kesin Konum'u açın.`,
				...(iosApp === "Safari"
					? [
							"Ayarlar → Uygulamalar → Safari → Konum: \"Sor\" ya da \"İzin Ver\" seçin.",
							"Safari'de adres çubuğundaki aA simgesi → Web Sitesi Ayarları → Konum → İzin Ver.",
						]
					: []),
				"Sonra aşağıdaki \"Tekrar dene\" butonuna basın.",
			]
		: [
				"Adres çubuğundaki kilit ya da ayar simgesine dokunun → İzinler → Konum → İzin ver.",
				"Telefonun Ayarlar → Konum'unun açık olduğundan emin olun.",
				"Sonra aşağıdaki \"Tekrar dene\" butonuna basın.",
			];

	const showHelp = (show) => {
		if (help) {
			help.replaceChildren(...(show ? steps.map((step) => Object.assign(document.createElement("li"), { textContent: step })) : []));
			help.hidden = !show;
		}
		if (retry) retry.hidden = !show;
	};

	const onError = (error) => {
		if (error.code === error.PERMISSION_DENIED) {
			say("Konum izni yok. Yolcu aracı göremez. Açmak için:", "error");
			showHelp(true);
		} else {
			say("Konum alınamıyor. GPS'in açık olduğundan ve açık havada olduğunuzdan emin olun.", "warn");
			showHelp(false);
			if (retry) retry.hidden = false;
		}
	};

	const keepAwake = async () => {
		try {
			wakeLock = await navigator.wakeLock?.request("screen");
		} catch {
			// Not supported or refused: sharing still works while the page is open.
		}
	};

	const begin = () => {
		if (watch !== null) navigator.geolocation.clearWatch(watch);
		say("Konum izni isteniyor…", "warn");
		watch = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
		keepAwake();
	};
	// A tap counts as the driver's own request, which some phones need before they ask.
	retry?.addEventListener("click", begin);
	begin();
	// The phone may hold back updates when standing still: resend the latest one now and then.
	setInterval(() => {
		if (watch !== null && pending && Date.now() - lastSent >= SEND_EVERY_MS * 2) send(pending);
	}, SEND_EVERY_MS);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && watch !== null) keepAwake();
	});
})();
