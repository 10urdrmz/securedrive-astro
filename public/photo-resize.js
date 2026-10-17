// Shrinks a chosen photo in the browser (longest side 1600 px, JPEG) before the form
// uploads it, so phone pictures stay small. Without canvas support the original goes.
(() => {
	const MAX = 1600;
	for (const input of document.querySelectorAll("input[type=file][data-resize]")) {
		input.addEventListener("change", async () => {
			const file = input.files && input.files[0];
			if (!file || !file.type.startsWith("image/") || typeof DataTransfer === "undefined") return;
			try {
				const bitmap = await createImageBitmap(file);
				const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
				if (scale === 1 && file.size < 1_500_000) return;
				const canvas = document.createElement("canvas");
				canvas.width = Math.round(bitmap.width * scale);
				canvas.height = Math.round(bitmap.height * scale);
				canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
				if (!blob) return;
				const dt = new DataTransfer();
				dt.items.add(new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }));
				input.files = dt.files;
			} catch {
				// Keep the original file.
			}
		});
	}
})();
