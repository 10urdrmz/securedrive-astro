/**
 * Management reports (Faz 6.3): what a month brought in and cost, by channel, route,
 * vehicle class, driver and partner, and the last twelve months as a trend.
 *
 * Revenue is what passengers and accounts pay for completed trips (price_minor); cost
 * is what we owe the driver or partner for them (the partner's accepted payout, else
 * the booking's driver payout). Bookings are counted in the month of their pickup.
 * Volumes are small, so one query loads the month and the grouping happens here.
 */
import { sql } from "kysely";
import type { Db } from "./db";
import { monthRange } from "./companies";

export interface ReportRow {
	id: string;
	status: string;
	source: string;
	agency_id: string | null;
	org_id: string | null;
	pickup_at: string;
	price_minor: number;
	payout_minor: number | null;
	route: string;
	class_name: string;
	driver_id: string | null;
	driver_name: string | null;
	driver_kind: string | null;
	partner_id: string | null;
	partner_name: string | null;
	rating: number | null;
}

export interface Group {
	key: string;
	label: string;
	/** Bookings, cancellations left out. */
	trips: number;
	completed: number;
	cancelled: number;
	revenue: number;
	cost: number;
	ratingSum: number;
	ratings: number;
	extra: number;
}

const CHANNELS: Record<string, string> = {
	web: "Web sitesi",
	web_ref: "Acente linki / widget",
	agency: "Acente paneli",
	company: "Kurumsal",
	ops: "Operasyon (telefon, teklif)",
};

export const channelOf = (r: Pick<ReportRow, "source" | "agency_id">) => (r.source === "web" && r.agency_id ? "web_ref" : r.source);
export const channelLabel = (key: string) => CHANNELS[key] ?? key;

async function rows(db: Db, start: string, end: string): Promise<ReportRow[]> {
	const list = await db
		.selectFrom("sd_bookings as b")
		.innerJoin("sd_zones as f", "f.id", "b.from_zone_id")
		.innerJoin("sd_zones as t", "t.id", "b.to_zone_id")
		.innerJoin("sd_vehicle_classes as c", "c.key", "b.class_key")
		.leftJoin("sd_drivers as d", "d.id", "b.driver_id")
		.leftJoin("sd_orgs as o", "o.id", "b.carrier_org_id")
		.leftJoin("sd_carrier_jobs as j", (join) => join.onRef("j.booking_id", "=", "b.id").on("j.status", "=", "accepted"))
		.leftJoin("sd_reviews as r", "r.booking_id", "b.id")
		.select([
			"b.id",
			"b.status",
			"b.source",
			"b.agency_id",
			"b.org_id",
			"b.pickup_at",
			"b.price_minor",
			sql<number | null>`case when b.carrier_org_id is not null then j.payout_minor else b.payout_minor end`.as("payout_minor"),
			sql<string>`f.name || ' → ' || t.name`.as("route"),
			"c.name as class_name",
			"b.driver_id",
			"d.name as driver_name",
			"d.kind as driver_kind",
			"b.carrier_org_id as partner_id",
			"o.name as partner_name",
			"r.rating",
		])
		.where("b.status", "!=", "quoted")
		.where("b.pickup_at", ">=", start)
		.where("b.pickup_at", "<", end)
		.limit(20000)
		.execute();
	return list as ReportRow[];
}

function group(list: ReportRow[], keyOf: (r: ReportRow) => string | null, labelOf: (r: ReportRow) => string): Group[] {
	const map = new Map<string, Group>();
	for (const r of list) {
		const key = keyOf(r);
		if (key == null) continue;
		let g = map.get(key);
		if (!g) {
			g = { key, label: labelOf(r), trips: 0, completed: 0, cancelled: 0, revenue: 0, cost: 0, ratingSum: 0, ratings: 0, extra: 0 };
			map.set(key, g);
		}
		if (r.status === "cancelled") {
			g.cancelled++;
			continue;
		}
		g.trips++;
		if (r.status === "completed") {
			g.completed++;
			g.revenue += r.price_minor;
			g.cost += r.payout_minor ?? 0;
		}
		if (r.rating) {
			g.ratingSum += r.rating;
			g.ratings++;
		}
	}
	return [...map.values()].sort((a, b) => b.revenue - a.revenue || b.trips - a.trips);
}

export interface MonthReport {
	totals: Group;
	/** Completed trips with no payout amount: their cost is missing from the margin. */
	missingPayout: number;
	/** Confirmed, not yet driven: what the month still brings if they happen. */
	upcoming: { trips: number; revenue: number };
	noShow: number;
	channels: Group[];
	routes: Group[];
	classes: Group[];
	drivers: Group[];
	partners: Group[];
}

export async function monthReport(db: Db, month: string): Promise<MonthReport> {
	const { start, end } = monthRange(month);
	const list = await rows(db, start, end);
	const [totals] = group(list, () => "all", () => "Toplam");
	const empty: Group = { key: "all", label: "Toplam", trips: 0, completed: 0, cancelled: 0, revenue: 0, cost: 0, ratingSum: 0, ratings: 0, extra: 0 };
	const drivers = group(
		list,
		(r) => (r.partner_id ? null : r.driver_id),
		(r) => `${r.driver_name ?? "?"}${r.driver_kind === "independent" ? " (bağımsız)" : ""}`,
	);
	// Offers a driver turned down or let time out, from the booking history.
	const declines = await db
		.selectFrom("sd_booking_events")
		.select([sql<string>`json_extract(data, '$.driverId')`.as("driver_id"), (eb) => eb.fn.countAll<number>().as("n")])
		.where("type", "in", ["driver_declined", "offer_timed_out"])
		.where("at", ">=", start)
		.where("at", "<", end)
		.groupBy(sql`json_extract(data, '$.driverId')`)
		.execute();
	const declinesOf = new Map(declines.map((d) => [d.driver_id, Number(d.n)]));
	for (const d of drivers) d.extra = declinesOf.get(d.key) ?? 0;
	return {
		totals: totals ?? empty,
		missingPayout: list.filter((r) => r.status === "completed" && r.payout_minor == null).length,
		upcoming: list
			.filter((r) => ["confirmed", "assigned", "pending_payment", "driver_en_route", "driver_arrived", "on_board"].includes(r.status))
			.reduce((acc, r) => ({ trips: acc.trips + 1, revenue: acc.revenue + r.price_minor }), { trips: 0, revenue: 0 }),
		noShow: list.filter((r) => r.status === "no_show").length,
		channels: group(list, channelOf, (r) => channelLabel(channelOf(r))),
		routes: group(list, (r) => r.route, (r) => r.route).slice(0, 15),
		classes: group(list, (r) => r.class_name, (r) => r.class_name),
		drivers,
		partners: group(list, (r) => r.partner_id, (r) => r.partner_name ?? "?"),
	};
}

export interface TrendPoint {
	month: string;
	completed: number;
	revenue: number;
	cost: number;
	cancelled: number;
}

/** The twelve months up to and including `month`. */
export async function trend(db: Db, month: string): Promise<TrendPoint[]> {
	const [y, m] = month.split("-").map(Number);
	const months = Array.from({ length: 12 }, (_, i) => {
		const d = new Date(Date.UTC(y, m - 12 + i, 1));
		return d.toISOString().slice(0, 7);
	});
	const list = await rows(db, monthRange(months[0]).start, monthRange(month).end);
	const istanbulMonth = (iso: string) => new Date(Date.parse(iso) + 3 * 3600_000).toISOString().slice(0, 7);
	const points = new Map(months.map((k) => [k, { month: k, completed: 0, revenue: 0, cost: 0, cancelled: 0 }]));
	for (const r of list) {
		const p = points.get(istanbulMonth(r.pickup_at));
		if (!p) continue;
		if (r.status === "cancelled") p.cancelled++;
		if (r.status === "completed") {
			p.completed++;
			p.revenue += r.price_minor;
			p.cost += r.payout_minor ?? 0;
		}
	}
	return [...points.values()];
}
