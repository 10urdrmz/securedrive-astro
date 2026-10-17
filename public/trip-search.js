// Trip search bar (components/TripSearch.astro): searchable place fields, formatted
// date and time, passenger and luggage popover. Without this script the form keeps
// its native selects and inputs.
(() => {
	const fold = (s) =>
		(s || "")
			.toLocaleLowerCase("tr-TR")
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/ı/g, "i")
			.trim();

	for (const form of document.querySelectorAll("[data-trip-search]")) {
		if (form.classList.contains("is-enhanced")) continue;
		form.classList.add("is-enhanced");
		form.noValidate = true;
		const intl = form.dataset.intl || undefined;
		const fill = (text, n) => text.replace("{n}", String(n));
		const cells = [];

		const closeAll = (except) => {
			for (const c of cells) if (c !== except) c.close();
		};

		// Place fields.
		const places = [...form.querySelectorAll("[data-place]")].map((cell) => {
			const input = cell.querySelector(".ts-input");
			const select = cell.querySelector("select");
			const panel = cell.querySelector(".ts-panel");
			const options = [...panel.querySelectorAll(".ts-option")];
			const whenEmpty = panel.querySelectorAll("[data-when-empty]");
			const empty = panel.querySelector(".ts-empty");
			let active = -1;

			const visible = () => options.filter((o) => !o.hidden && !o.closest("[hidden]"));
			const setActive = (i) => {
				const list = visible();
				options.forEach((o) => o.classList.remove("is-active"));
				active = list.length && i >= 0 ? i % list.length : -1;
				if (active >= 0) {
					list[active].classList.add("is-active");
					list[active].scrollIntoView({ block: "nearest" });
				}
			};
			const filter = () => {
				const q = fold(input.value);
				const selectedName = select.selectedIndex > 0 ? select.options[select.selectedIndex].text : "";
				const query = q && q !== fold(selectedName) ? q : "";
				for (const o of options) {
					if (o.classList.contains("ts-chip")) continue;
					o.hidden = !!query && !fold(o.dataset.search).includes(query);
				}
				whenEmpty.forEach((el) => (el.hidden = !!query));
				for (const g of panel.querySelectorAll("[data-group]")) {
					const list = g.nextElementSibling;
					g.hidden = ![...list.children].some((o) => !o.hidden);
				}
				empty.hidden = visible().length > 0;
				setActive(query ? 0 : -1);
			};
			const api = {
				cell,
				open() {
					closeAll(api);
					panel.hidden = false;
					cell.classList.add("is-open");
					input.setAttribute("aria-expanded", "true");
					filter();
				},
				close() {
					panel.hidden = true;
					cell.classList.remove("is-open");
					input.setAttribute("aria-expanded", "false");
					// Typed text that was never picked goes back to the chosen place.
					const chosen = select.selectedIndex > 0 ? select.options[select.selectedIndex].text : "";
					if (input.value !== chosen) input.value = chosen;
				},
				pick(option) {
					select.value = option.dataset.value;
					input.value = option.dataset.name;
					options.forEach((o) => o.setAttribute("aria-selected", String(o.dataset.value === select.value)));
					cell.classList.remove("is-invalid");
					api.close();
					form.dispatchEvent(new CustomEvent("ts:picked", { detail: cell }));
				},
				sync() {
					input.value = select.selectedIndex > 0 ? select.options[select.selectedIndex].text : "";
					options.forEach((o) => o.setAttribute("aria-selected", String(o.dataset.value === select.value)));
				},
				focus() {
					input.focus();
				},
				select,
				input,
			};
			api.sync();

			input.addEventListener("focus", () => {
				api.open();
				input.select();
			});
			input.addEventListener("click", () => {
				if (panel.hidden) api.open();
			});
			input.addEventListener("input", () => {
				if (panel.hidden) api.open();
				filter();
			});
			input.addEventListener("keydown", (e) => {
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault();
					if (panel.hidden) api.open();
					const n = visible().length;
					setActive(e.key === "ArrowDown" ? active + 1 : active <= 0 ? n - 1 : active - 1);
				} else if (e.key === "Enter") {
					const list = visible();
					if (!panel.hidden && list.length) {
						e.preventDefault();
						api.pick(list[Math.max(active, 0)]);
					}
				} else if (e.key === "Escape") {
					api.close();
				} else if (e.key === "Tab" && !panel.hidden) {
					const list = visible();
					if (fold(input.value) && list.length) api.pick(list[Math.max(active, 0)]);
					else api.close();
				}
			});
			// mousedown keeps focus in the input, so the panel does not close before the click.
			panel.addEventListener("mousedown", (e) => e.preventDefault());
			panel.addEventListener("click", (e) => {
				const option = e.target.closest(".ts-option");
				if (option) api.pick(option);
			});
			cell.addEventListener("click", (e) => {
				if (e.target === cell || e.target.classList.contains("ts-label")) input.focus();
			});
			cells.push(api);
			return api;
		});

		const [from, to] = places;
		form.addEventListener("ts:picked", (e) => {
			// After the pickup, go straight on to the destination, like a flight search.
			if (from && to && e.detail === from.cell && !to.select.value) to.focus();
		});

		form.querySelector("[data-swap]")?.addEventListener("click", () => {
			if (!from || !to) return;
			[from.select.value, to.select.value] = [to.select.value, from.select.value];
			from.sync();
			to.sync();
		});

		// Date and time: formatted text over the real input, which opens the native picker.
		const pickers = [...form.querySelectorAll("[data-picker]")].map((cell) => {
			const input = cell.querySelector("input");
			const display = cell.querySelector("[data-display]");
			const render = () => {
				const v = input.value;
				display.classList.toggle("is-empty", !v);
				if (!v) {
					display.textContent = cell.dataset.picker === "time" ? form.dataset.timeEmpty : "—";
				} else if (cell.dataset.picker === "date") {
					const [y, m, d] = v.split("-").map(Number);
					display.textContent = new Date(y, m - 1, d).toLocaleDateString(intl, { day: "numeric", month: "short", weekday: "short" });
				} else {
					display.textContent = v;
				}
				if (v) cell.classList.remove("is-invalid");
			};
			const show = () => {
				closeAll();
				if (typeof input.showPicker !== "function") {
					// No picker API: let the visitor type into the native input.
					cell.classList.add("is-native");
					input.focus();
					return;
				}
				try {
					input.showPicker();
				} catch {
					// Already open, or the browser refused; the native control still works.
				}
			};
			input.addEventListener("click", show);
			input.addEventListener("change", render);
			input.addEventListener("input", render);
			render();
			return { cell, input, show };
		});

		// Passengers and luggage.
		const people = form.querySelector("[data-people]");
		if (people) {
			const btn = people.querySelector(".ts-people-btn");
			const summary = people.querySelector("[data-people-summary]");
			const pax = people.querySelector('input[name="pax"]');
			const bags = people.querySelector('input[name="bags"]');
			const clamp = (input) => {
				const min = Number(input.min || 0);
				const max = Number(input.max || 60);
				let n = parseInt(input.value, 10);
				if (Number.isNaN(n)) n = min;
				input.value = String(Math.min(max, Math.max(min, n)));
			};
			const render = () => {
				for (const input of [pax, bags]) {
					people.querySelector(`[data-for="${input.id}"][data-step="-1"]`).disabled = Number(input.value) <= Number(input.min || 0);
					people.querySelector(`[data-for="${input.id}"][data-step="1"]`).disabled = Number(input.value) >= Number(input.max || 60);
				}
				summary.textContent = `${fill(form.dataset.paxLabel, pax.value)}, ${fill(form.dataset.bagsLabel, bags.value)}`;
			};
			const api = {
				cell: people,
				open() {
					closeAll(api);
					people.classList.add("is-open");
					btn.setAttribute("aria-expanded", "true");
				},
				close() {
					people.classList.remove("is-open");
					btn.setAttribute("aria-expanded", "false");
				},
			};
			cells.push(api);
			btn.addEventListener("click", () => (people.classList.contains("is-open") ? api.close() : api.open()));
			people.addEventListener("click", (e) => {
				const step = e.target.closest("[data-step]");
				if (step) {
					const input = form.querySelector(`#${step.dataset.for}`);
					input.value = String(Number(input.value) + Number(step.dataset.step));
					clamp(input);
					render();
				}
				if (e.target.closest("[data-people-done]")) {
					api.close();
					btn.focus();
				}
			});
			for (const input of [pax, bags]) {
				input.addEventListener("change", () => {
					clamp(input);
					render();
				});
			}
			people.addEventListener("keydown", (e) => {
				if (e.key === "Escape") {
					api.close();
					btn.focus();
				}
			});
			render();
		}

		// Clicks outside a field close its panel.
		document.addEventListener("click", (e) => {
			for (const c of cells) if (!c.cell.contains(e.target)) c.close();
		});
		form.addEventListener("focusout", (e) => {
			for (const c of cells) {
				if (c.cell.contains(e.target) && !c.cell.contains(e.relatedTarget) && e.relatedTarget) c.close();
			}
		});

		// The native checks cannot point at hidden selects, so the bar checks itself.
		form.addEventListener("submit", (e) => {
			for (const p of places) {
				if (!p.select.value) {
					e.preventDefault();
					p.cell.classList.add("is-invalid");
					p.focus();
					return;
				}
			}
			for (const p of pickers) {
				if (!p.input.value) {
					e.preventDefault();
					p.cell.classList.add("is-invalid");
					p.show();
					return;
				}
			}
		});
	}
})();
