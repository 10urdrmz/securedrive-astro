/*
 * Driver app: shares the phone's position while this trip is live, so ops and the
 * passenger can follow the car. Runs only on a job page marked data-track-code and
 * stops by itself when the server says the trip is over.
 *
 * A web page cannot share location while the phone is locked or another app (Maps,
 * WhatsApp) is in front, so the script restarts itself whenever the page is shown
 * again and tells the driver plainly what is happening.
 */
(() => {
	const box = document.querySelector("[data-track-code]");
	if (!box) return;
	const code = box.dataset.trackCode;
	const status = box.querySelector("[data-track-status]");
	const help = box.querySelector("[data-track-help]");
	const retry = box.querySelector("[data-track-retry]");
	const SEND_EVERY_MS = 15000;
	/** No fix for this long while the page is open: tell the driver. */
	const STALE_MS = 60000;
	/** Worse than this the phone is guessing from cell towers (Precise Location off). */
	const COARSE_M = 500;

	let lastSent = 0;
	let lastFix = 0;
	let pending = null;
	let watch = null;
	let wakeLock = null;
	let stopped = false;
	let highAccuracy = true;
	let restartTimer = null;
	let sending = false;

	const ua = navigator.userAgent;
	const iphone = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
	const iosApp = /CriOS/.test(ua) ? "Chrome" : /FxiOS/.test(ua) ? "Firefox" : /EdgiOS/.test(ua) ? "Edge" : "Safari";
	// Browsers inside other apps often have no location at all.
	const inApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|TikTok|GSA\//.test(ua);

	const say = (text, tone) => {
		if (!status) return;
		status.textContent = text;
		box.dataset.tone = tone;
	};

	const PERMISSION_STEPS = iphone
		? [
				"Sayfayı WhatsApp ya da başka bir uygulamanın içinden açtıysanız Safari'de açın (paylaş → Safari'de Aç).",
				"Ayarlar → Gizlilik ve Güvenlik → Konum Servisleri açık olsun.",
				iosApp === "Safari"
					? "Aynı sayfanın altında Safari Web Siteleri → \"Uygulamayı Kullanırken\" seçin, Kesin Konum'u açın."
					: `Aynı sayfada ${iosApp} → "Uygulamayı Kullanırken" seçin, Kesin Konum'u açın.`,
				...(iosApp === "Safari"
					? [
							"Ayarlar → Uygulamalar → Safari → Konum: \"İzin Ver\" seçin (\"Sor\" seçiliyse her sayfada tekrar sorar).",
							"Safari'de adres çubuğundaki aA simgesi → Web Sitesi Ayarları → Konum → İzin Ver.",
						]
					: []),
				"Sonra aşağıdaki \"Tekrar dene\" butonuna basın.",
			]
		: [
				...(inApp ? ["Sayfayı uygulamanın içinden açtıysanız menüden \"Tarayıcıda aç\" ile Chrome'da açın."] : []),
				"Adres çubuğundaki kilit ya da ayar simgesine dokunun → İzinler → Konum → İzin ver.",
				"Telefonun Ayarlar → Konum'u açık olsun, Google konum doğruluğu açık olsun.",
				"Sonra aşağıdaki \"Tekrar dene\" butonuna basın.",
			];
	const PRECISE_STEPS = iphone
		? [
				`Ayarlar → Gizlilik ve Güvenlik → Konum Servisleri → ${iosApp === "Safari" ? "Safari Web Siteleri" : iosApp} → Kesin Konum'u açın.`,
				"Sonra \"Tekrar dene\" butonuna basın.",
			]
		: ["Adres çubuğundaki ayar simgesi → İzinler → Konum'da \"Tam konum\" seçin.", "Sonra \"Tekrar dene\" butonuna basın."];

	const showHelp = (steps) => {
		if (help) {
			help.replaceChildren(...(steps ?? []).map((step) => Object.assign(document.createElement("li"), { textContent: step })));
			help.hidden = !steps;
		}
		if (retry) retry.hidden = !steps;
	};

	const stop = () => {
		stopped = true;
		if (watch !== null) navigator.geolocation.clearWatch(watch);
		watch = null;
		clearTimeout(restartTimer);
		wakeLock?.release?.().catch(() => {});
		showHelp(null);
		say("Yolculuk bitti, konum paylaşımı durdu.", "off");
	};

	const clock = () => new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

	const send = async (position) => {
		if (sending || stopped) return;
		sending = true;
		lastSent = Date.now();
		const { latitude, longitude, accuracy, heading, speed } = position.coords;
		// iPhones report -1 for an unknown heading or speed.
		const known = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
		try {
			const response = await fetch("/surucu/konum", {
				method: "POST",
				credentials: "same-origin",
				cache: "no-store",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code, lat: latitude, lng: longitude, accuracy: known(accuracy), heading: known(heading), speed: known(speed) }),
			});
			const result = await response.json().catch(() => ({}));
			if (response.status === 401) {
				say("Oturumunuz kapanmış. Konum gönderilemiyor; çıkıp tekrar giriş yapın.", "error");
				return;
			}
			if (response.status === 404) {
				say("Bu iş artık size atanmış görünmüyor. Operasyonu arayın.", "error");
				return;
			}
			if (!response.ok) {
				say("Sunucu konumu kabul etmedi, birazdan tekrar denenecek.", "warn");
				lastSent = 0;
				return;
			}
			if (result.track === false) return stop();
			if (accuracy > COARSE_M) {
				say(`Konum paylaşılıyor ama yaklaşık (±${Math.round(accuracy / 100) / 10} km). Kesin Konum kapalı olabilir:`, "warn");
				showHelp(PRECISE_STEPS);
			} else {
				showHelp(null);
				say(`Konumunuz paylaşılıyor · son gönderim ${clock()}`, "ok");
			}
		} catch {
			lastSent = 0;
			say("İnternet yok. Bağlantı gelince konum otomatik gönderilecek.", "warn");
		} finally {
			sending = false;
		}
	};

	const onPosition = (position) => {
		lastFix = Date.now();
		pending = position;
		clearTimeout(restartTimer);
		// Recovering from a warning or error: report at once so the screen stops showing it.
		const recovering = box.dataset.tone !== "ok" && Date.now() - lastSent >= 3000;
		if (recovering || Date.now() - lastSent >= SEND_EVERY_MS) send(position);
	};

	const onError = (error) => {
		if (stopped) return;
		if (error.code === 1) {
			say(inApp ? "Bu uygulamanın içindeki tarayıcı konuma izin vermiyor. Açmak için:" : "Konum izni yok. Yolcu aracı göremez. Açmak için:", "error");
			showHelp(PERMISSION_STEPS);
			if (watch !== null) navigator.geolocation.clearWatch(watch);
			watch = null;
			return;
		}
		// No fix yet (indoors, car park, GPS warming up): try the other accuracy mode and keep going.
		if (Date.now() - lastFix > SEND_EVERY_MS) {
			say("Konum bulunamıyor. GPS'in açık olduğundan emin olun; kapalı alandaysanız açık alana çıkınca düzelir.", "warn");
			if (retry) retry.hidden = false;
		}
		clearTimeout(restartTimer);
		restartTimer = setTimeout(() => {
			highAccuracy = !highAccuracy;
			begin(true);
		}, 10000);
	};

	const keepAwake = async () => {
		try {
			if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock?.request("screen");
		} catch {
			// Not supported or refused: sharing still works while the screen is on.
		}
	};

	const begin = (quiet) => {
		if (stopped) return;
		if (!("geolocation" in navigator) || !window.isSecureContext) {
			say("Bu tarayıcı konum paylaşamıyor. Safari ya da Chrome ile açın.", "error");
			return;
		}
		if (watch !== null) navigator.geolocation.clearWatch(watch);
		if (!quiet) say("Konum alınıyor…", "warn");
		watch = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: highAccuracy, maximumAge: 5000, timeout: 20000 });
		keepAwake();
	};

	// A tap counts as the driver's own request, which some phones need before they ask.
	retry?.addEventListener("click", () => {
		highAccuracy = true;
		lastSent = 0;
		showHelp(null);
		begin(false);
	});

	// Already refused: say so at once instead of waiting for the phone.
	const start = async () => {
		try {
			const permission = await navigator.permissions?.query({ name: "geolocation" });
			if (permission?.state === "denied") return onError({ code: 1 });
			permission?.addEventListener?.("change", () => {
				if (permission.state === "granted") begin(false);
				else if (permission.state === "denied") onError({ code: 1 });
			});
		} catch {
			// Older Safari has no permissions API for geolocation; just ask.
		}
		begin(false);
	};
	start();

	setInterval(() => {
		if (stopped || document.hidden) return;
		// The phone may hold back updates when standing still: resend the latest one now and then.
		if (pending && Date.now() - lastSent >= SEND_EVERY_MS * 2) send(pending);
		if (watch !== null && lastFix && Date.now() - lastFix > STALE_MS) {
			say("Konum bir dakikadır güncellenmiyor, yeniden deneniyor…", "warn");
			lastFix = Date.now();
			begin(true);
		}
	}, SEND_EVERY_MS);

	// Back from the lock screen, Maps or WhatsApp: the phone may have dropped the watch.
	const resume = () => {
		if (stopped || document.hidden || watch === null && box.dataset.tone === "error") return;
		lastSent = 0;
		begin(true);
	};
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			if (!stopped) say("Sayfa arka planda, konum paylaşımı duraklatıldı. Bu sayfaya dönünce devam eder.", "warn");
		} else resume();
	});
	window.addEventListener("pageshow", (event) => event.persisted && resume());
	window.addEventListener("online", () => pending && send(pending));
})();
