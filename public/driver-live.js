/**
 * Live Driver Job sync & AJAX step transitions:
 * Handles step button clicks seamlessly via fetch (no full page reload),
 * and continuously polls /surucu/durum.json to keep job status up to date.
 */
(() => {
	const headEl = document.querySelector(".head");
	if (!headEl) return;

	const codeEl = headEl.querySelector(".code");
	const code = codeEl ? codeEl.textContent.trim().toUpperCase() : "";
	if (!code) return;

	let currentVersion = null;
	let isSubmitting = false;

	// Initial version reading from form inputs if available
	const versionInput = document.querySelector('input[name="version"]');
	if (versionInput) {
		currentVersion = parseInt(versionInput.value, 10);
	}

	function showToast(text, tone = "info") {
		let toast = document.getElementById("drv-toast");
		if (!toast) {
			toast = document.createElement("div");
			toast.id = "drv-toast";
			toast.style.cssText = "position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 20px;border-radius:12px;font-size:14px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.25);z-index:99999;transition:all 0.3s ease;opacity:0;";
			document.body.appendChild(toast);
		}
		toast.textContent = text;
		toast.style.background = tone === "error" ? "#dc2626" : tone === "success" ? "#16a34a" : "#0f172a";
		toast.style.opacity = "1";
		toast.style.top = "24px";
		setTimeout(() => {
			toast.style.opacity = "0";
			toast.style.top = "16px";
		}, 3000);
	}

	async function refreshPageContent() {
		try {
			const res = await fetch(window.location.href);
			if (!res.ok) return;

			const html = await res.text();
			const parser = new DOMParser();
			const doc = parser.parseFromString(html, "text/html");

			// Replace main container content seamlessly
			const oldMain = document.querySelector("main") || document.body;
			const newMain = doc.querySelector("main") || doc.body;

			if (oldMain && newMain) {
				oldMain.innerHTML = newMain.innerHTML;

				// Update version tracker
				const newVersionInput = document.querySelector('input[name="version"]');
				if (newVersionInput) {
					currentVersion = parseInt(newVersionInput.value, 10);
				}

				// Re-attach AJAX form handlers
				bindActionForms();
			}
		} catch (e) {
			console.error("Failed to refresh job content", e);
		}
	}

	function bindActionForms() {
		// Forms that update status (accept, step, etc.)
		const actionForms = document.querySelectorAll('.actions form');
		actionForms.forEach((form) => {
			if (form.dataset.ajaxBound) return;
			form.dataset.ajaxBound = "true";

			form.addEventListener("submit", async (e) => {
				const submitBtn = form.querySelector('button[type="submit"]');
				const intent = form.querySelector('input[name="intent"]')?.value;

				// We handle step and accept via AJAX; decline can navigate
				if (intent !== "step" && intent !== "accept") return;

				e.preventDefault();
				if (isSubmitting) return;

				isSubmitting = true;
				const originalText = submitBtn ? submitBtn.textContent : "";
				if (submitBtn) {
					submitBtn.disabled = true;
					submitBtn.textContent = "İşleniyor…";
				}

				try {
					const formData = new FormData(form);
					const res = await fetch(window.location.href, {
						method: "POST",
						body: formData,
					});

					if (res.ok) {
						showToast("Durum güncellendi!", "success");
						await refreshPageContent();
					} else {
						showToast("İşlem yapılamadı, lütfen tekrar deneyin.", "error");
						await refreshPageContent();
					}
				} catch (err) {
					showToast("Bağlantı hatası oluştu.", "error");
				} finally {
					isSubmitting = false;
					if (submitBtn) {
						submitBtn.disabled = false;
						submitBtn.textContent = originalText;
					}
				}
			});
		});
	}

	async function pollStatus() {
		if (document.hidden || isSubmitting) return;

		try {
			const res = await fetch(`/surucu/durum.json?code=${encodeURIComponent(code)}`);
			if (!res.ok) return;

			const data = await res.json();
			if (currentVersion !== null && typeof data.version === "number" && data.version !== currentVersion) {
				currentVersion = data.version;
				showToast(`İş durumu güncellendi: ${data.badge?.label || data.status}`);
				await refreshPageContent();
			}
		} catch (err) {
			// silent background fail
		}
	}

	// Initialize bindings and polling
	bindActionForms();
	setInterval(pollStatus, 4000);
	window.addEventListener("focus", pollStatus);
})();
