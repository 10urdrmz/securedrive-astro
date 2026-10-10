/**
 * What needs ops' attention: the counts beside the menu entries and the bell's feed of
 * recent arrivals (new price requests and new web bookings). Read by OpsLayout on every
 * page and polled by the panel through /ops/bildirim.json.
 *
 * Price requests are personal data: only /ops may call this.
 */
import type { Db } from "./db";
import { can, type SessionUser } from "./auth/rbac";

export interface OpsCounts {
	/** Transfer price requests nobody has picked up yet. */
	requests: number;
	/** Upcoming bookings still waiting for a driver. */
	bookings: number;
}

export interface OpsFeedItem {
	key: string;
	kind: "request" | "booking" | "declined";
	title: string;
	detail: string;
	href: string;
	at: string;
}

const EMPTY: OpsCounts = { requests: 0, bookings: 0 };

export async function opsCounts(db: Db, user: SessionUser): Promise<OpsCounts> {
	if (!can(user, "bookings.read")) return EMPTY;
	const [requests, bookings] = await Promise.all([
		db
			.selectFrom("ec_inquiries")
			.select((eb) => eb.fn.countAll<number>().as("n"))
			.where("kind", "=", "transfer")
			.where("deleted_at", "is", null)
			.where((eb) => eb.or([eb("status_label", "is", null), eb("status_label", "=", "new")]))
			.executeTakeFirst(),
		db
			.selectFrom("sd_bookings")
			.select((eb) => eb.fn.countAll<number>().as("n"))
			.where("driver_id", "is", null)
			.where("status", "in", ["confirmed", "pending_payment"])
			.where("pickup_at", ">=", new Date(Date.now() - 6 * 3600_000).toISOString())
			.executeTakeFirst(),
	]);
	return {
		requests: Number(requests?.n ?? 0),
		bookings: Number(bookings?.n ?? 0),
	};
}

export async function opsFeed(db: Db, user: SessionUser, limit = 12): Promise<OpsFeedItem[]> {
	if (!can(user, "bookings.read")) return [];
	const [requests, bookings, declines] = await Promise.all([
		db
			.selectFrom("ec_inquiries")
			.select(["id", "reference", "name", "details", "created_at"])
			.where("kind", "=", "transfer")
			.where("deleted_at", "is", null)
			.orderBy("created_at", "desc")
			.limit(limit)
			.execute(),
		db
			.selectFrom("sd_bookings as b")
			.leftJoin("sd_zones as f", "f.id", "b.from_zone_id")
			.leftJoin("sd_zones as t", "t.id", "b.to_zone_id")
			.select(["b.code", "b.contact_name", "b.created_at", "f.name as from_name", "t.name as to_name"])
			.where("b.source", "=", "web")
			.orderBy("b.created_at", "desc")
			.limit(limit)
			.execute(),
		db
			.selectFrom("sd_booking_events as e")
			.innerJoin("sd_bookings as b", "b.id", "e.booking_id")
			.select(["e.id", "e.at", "e.data", "b.code"])
			.where("e.type", "=", "driver_declined")
			.orderBy("e.at", "desc")
			.limit(limit)
			.execute(),
	]);
	const route = (details: unknown) => {
		try {
			const d = (typeof details === "string" ? JSON.parse(details) : details) as { from?: string; to?: string } | null;
			return d?.from && d?.to ? `${d.from} → ${d.to}` : "";
		} catch {
			return "";
		}
	};
	const items: OpsFeedItem[] = [
		...requests.map((r) => ({
			key: `request:${r.id}`,
			kind: "request" as const,
			title: `Yeni fiyat talebi · ${r.reference || r.id}`,
			detail: [r.name, route(r.details)].filter(Boolean).join(" · "),
			href: "/ops/talepler",
			at: String(r.created_at),
		})),
		...bookings.map((b) => ({
			key: `booking:${b.code}`,
			kind: "booking" as const,
			title: `Yeni rezervasyon · ${b.code}`,
			detail: [b.contact_name, b.from_name && b.to_name ? `${b.from_name} → ${b.to_name}` : ""].filter(Boolean).join(" · "),
			href: `/ops/rezervasyonlar/${b.code}`,
			at: String(b.created_at),
		})),
		...declines.map((d) => {
			let name = "";
			try {
				name = (JSON.parse(String(d.data)) as { driverName?: string }).driverName ?? "";
			} catch {
				// The title alone is enough.
			}
			return {
				key: `declined:${d.id}`,
				kind: "declined" as const,
				title: `Sürücü işi reddetti · ${d.code}`,
				detail: name ? `${name} · yeni sürücü atayın` : "Yeni sürücü atayın",
				href: `/ops/rezervasyonlar/${d.code}`,
				at: String(d.at),
			};
		}),
	];
	return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}
