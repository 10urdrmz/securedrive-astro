/**
 * Price engine. Every channel (web wizard, ops phone booking, later B2B and API) asks
 * `quote()`; prices are only ever computed on the server and recomputed at submit.
 *
 * Phase 3 covers fixed tariffs (mode A): a price exists only when ops entered one for
 * the zone pair and vehicle class. No tariff → no price → the visitor gets the
 * "request a quote" form instead.
 */
import type { Db } from "./db";
import { getSettings, type BusinessSettings } from "./settings";

/** Istanbul has been on UTC+3 all year since 2016. */
const ISTANBUL_OFFSET = "+03:00";

export interface QuoteInput {
	fromZoneId: string;
	toZoneId: string;
	/** Pickup date and time as typed, in Istanbul time. */
	date: string; // YYYY-MM-DD
	time: string; // HH:MM
	pax: number;
	bags: number;
	extras?: Record<string, number>;
	/** Company or agency id for a contract tariff; '' for the public price. */
	orgId?: string;
}

export type LineKind = "base" | "night" | "lastMinute" | "extra";

export interface QuoteLine {
	kind: LineKind;
	/** Turkish label, stored on the booking; public pages translate by kind. */
	label: string;
	/** For extras: which one, and how many. */
	key?: string;
	qty?: number;
	amount_minor: number;
}

export interface ClassQuote {
	classKey: string;
	name: string;
	paxMax: number;
	bagsMax: number;
	/** Pax and bags fit the vehicle. */
	fits: boolean;
	lines: QuoteLine[];
	total_minor: number;
	payout_minor: number | null;
}

export type QuoteError = "invalidInput" | "notServiceable" | "tooSoon" | "past";

export interface Quote {
	pickupAt: string; // ISO UTC
	from: { id: string; name: string; kind: string };
	to: { id: string; name: string; kind: string };
	/** One entry per active class that has a tariff on this route, cheapest first. */
	options: ClassQuote[];
	extras: { key: string; name: string; price_minor: number; max_qty: number }[];
	settings: BusinessSettings;
}

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "2026-10-12" + "14:30" in Istanbul → ISO UTC, or null when not a real date. */
export function istanbulToIso(date: string, time: string): string | null {
	if (!DATE.test(date) || !TIME.test(time)) return null;
	const at = new Date(`${date}T${time}:00${ISTANBUL_OFFSET}`);
	return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** ISO UTC → { date, time } in Istanbul, for forms and display. */
export function isoToIstanbul(iso: string): { date: string; time: string } {
	const local = new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString();
	return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Night window may wrap midnight (22:00–06:00) or not (00:00–06:00). */
function inNightWindow(time: string, start: string, end: string): boolean {
	const t = minutes(time);
	const s = minutes(start);
	const e = minutes(end);
	if (s === e) return false;
	return s < e ? t >= s && t < e : t >= s || t < e;
}

const percent = (amount: number, pct: number) => Math.round((amount * pct) / 100);

export async function quote(
	db: Db,
	input: QuoteInput,
	options: { now?: Date; ignoreLeadTime?: boolean } = {},
): Promise<{ ok: true; quote: Quote } | { ok: false; error: QuoteError }> {
	const pickupAt = istanbulToIso(input.date, input.time);
	if (!pickupAt || input.fromZoneId === input.toZoneId || input.pax < 1 || input.pax > 60 || input.bags < 0 || input.bags > 60) {
		return { ok: false, error: "invalidInput" };
	}
	const now = options.now ?? new Date();
	const settings = await getSettings(db);
	const hoursAhead = (new Date(pickupAt).getTime() - now.getTime()) / 3600_000;
	if (hoursAhead < 0) return { ok: false, error: "past" };
	if (!options.ignoreLeadTime && hoursAhead < settings.minLeadHours) return { ok: false, error: "tooSoon" };

	const zones = await db
		.selectFrom("sd_zones")
		.select(["id", "name", "kind", "serviceable"])
		.where("id", "in", [input.fromZoneId, input.toZoneId])
		.execute();
	const from = zones.find((z) => z.id === input.fromZoneId);
	const to = zones.find((z) => z.id === input.toZoneId);
	if (!from || !to) return { ok: false, error: "invalidInput" };
	if (!from.serviceable || !to.serviceable) return { ok: false, error: "notServiceable" };

	const orgId = input.orgId ?? "";
	const rows = await db
		.selectFrom("sd_tariffs as t")
		.innerJoin("sd_vehicle_classes as c", "c.key", "t.class_key")
		.select(["t.class_key", "t.org_id", "t.price_minor", "t.driver_payout_minor", "c.name", "c.pax_max", "c.bags_max", "c.sort"])
		.where("t.from_zone_id", "=", from.id)
		.where("t.to_zone_id", "=", to.id)
		.where("t.org_id", "in", orgId ? ["", orgId] : [""])
		.where("c.active", "=", 1)
		.execute();
	// A contract tariff wins over the public one for the same class.
	const byClass = new Map<string, (typeof rows)[number]>();
	for (const row of rows) if (!byClass.has(row.class_key) || row.org_id) byClass.set(row.class_key, row);

	const extrasCatalog = await db
		.selectFrom("sd_extras")
		.select(["key", "name", "price_minor", "max_qty"])
		.where("active", "=", 1)
		.orderBy("sort")
		.execute();

	const night = inNightWindow(input.time, settings.nightStart, settings.nightEnd) && settings.nightSurchargePct > 0;
	const lastMinute = hoursAhead < settings.lastMinuteHours && settings.lastMinutePct > 0;

	const extraLines: QuoteLine[] = [];
	for (const extra of extrasCatalog) {
		const qty = Math.min(Math.max(Math.floor(input.extras?.[extra.key] ?? 0), 0), extra.max_qty);
		if (qty > 0) {
			extraLines.push({ kind: "extra", label: extra.name, key: extra.key, qty, amount_minor: extra.price_minor * qty });
		}
	}

	const quotes: ClassQuote[] = [...byClass.values()]
		.sort((a, b) => a.price_minor - b.price_minor || a.sort - b.sort)
		.map((row) => {
			const base = row.price_minor;
			const lines: QuoteLine[] = [{ kind: "base", label: `${from.name} → ${to.name}, ${row.name}`, amount_minor: base }];
			if (night) lines.push({ kind: "night", label: `Gece eki (%${settings.nightSurchargePct})`, amount_minor: percent(base, settings.nightSurchargePct) });
			if (lastMinute) lines.push({ kind: "lastMinute", label: `Son dakika eki (%${settings.lastMinutePct})`, amount_minor: percent(base, settings.lastMinutePct) });
			lines.push(...extraLines);
			return {
				classKey: row.class_key,
				name: row.name,
				paxMax: row.pax_max,
				bagsMax: row.bags_max,
				fits: input.pax <= row.pax_max && input.bags <= row.bags_max,
				lines,
				total_minor: lines.reduce((sum, line) => sum + line.amount_minor, 0),
				payout_minor: row.driver_payout_minor ?? null,
			};
		});

	return {
		ok: true,
		quote: {
			pickupAt,
			from: { id: from.id, name: from.name, kind: from.kind },
			to: { id: to.id, name: to.name, kind: to.kind },
			options: quotes,
			extras: extrasCatalog,
			settings,
		},
	};
}

/** Share of the price refunded when cancelled now, per the cancellation policy. */
export function refundPct(settings: BusinessSettings, pickupAt: string, now = new Date()): number {
	const hours = (new Date(pickupAt).getTime() - now.getTime()) / 3600_000;
	const rules = [...settings.cancellation].sort((a, b) => b.hoursBefore - a.hoursBefore);
	for (const rule of rules) if (hours >= rule.hoursBefore) return rule.refundPct;
	return 0;
}
