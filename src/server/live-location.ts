/**
 * Live location: the driver app sends the phone's position while a trip is under way
 * (en route, at pickup, passenger on board); ops and the passenger see it on a map.
 *
 * Only the latest position per driver is kept, and it is shown only while the trip is
 * live and the position is fresh, so a driver is never tracked off the job.
 */
import type { Db } from "./db";
import type { Booking, BookingStatus } from "./bookings";

export const TRACKED_STATUSES: BookingStatus[] = ["driver_en_route", "driver_arrived", "on_board"];
/** A position older than this is not shown as live. */
const FRESH_MINUTES = 10;
/** The phone may send more often; we store at most one position per driver this often. */
const MIN_INTERVAL_MS = 5_000;

export interface Position {
	lat: number;
	lng: number;
	accuracy: number | null;
	heading: number | null;
	speed: number | null;
	at: string;
}

export const isTracked = (status: BookingStatus) => TRACKED_STATUSES.includes(status);

const num = (value: unknown, min: number, max: number): number | null => {
	const n = typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/** Validates a position the phone sent; null if it is not a usable position. */
export function readPosition(body: Record<string, unknown>): Omit<Position, "at"> | null {
	const lat = num(body.lat, -90, 90);
	const lng = num(body.lng, -180, 180);
	if (lat === null || lng === null) return null;
	return { lat, lng, accuracy: num(body.accuracy, 0, 100_000), heading: num(body.heading, 0, 360), speed: num(body.speed, 0, 150) };
}

/** Stores the driver's position for a live trip. Returns false when it was too soon after the last one. */
export async function savePosition(db: Db, driverId: string, booking: Booking, position: Omit<Position, "at">): Promise<boolean> {
	const now = new Date();
	const last = await db.selectFrom("sd_driver_locations").select("at").where("driver_id", "=", driverId).executeTakeFirst();
	if (last && now.getTime() - Date.parse(last.at) < MIN_INTERVAL_MS) return false;
	const values = { booking_id: booking.id, ...position, at: now.toISOString() };
	await db
		.insertInto("sd_driver_locations")
		.values({ driver_id: driverId, ...values })
		.onConflict((oc) => oc.column("driver_id").doUpdateSet(values))
		.execute();
	return true;
}

const freshSince = () => new Date(Date.now() - FRESH_MINUTES * 60_000).toISOString();

const toPosition = (row: { lat: number; lng: number; accuracy: number | null; heading: number | null; speed: number | null; at: string }): Position => ({
	lat: Number(row.lat),
	lng: Number(row.lng),
	accuracy: row.accuracy == null ? null : Number(row.accuracy),
	heading: row.heading == null ? null : Number(row.heading),
	speed: row.speed == null ? null : Number(row.speed),
	at: row.at,
});

/** Where the booking's car is now, if the trip is live and the driver's phone has reported lately. */
export async function bookingPosition(db: Db, booking: Booking): Promise<Position | null> {
	if (!booking.driver_id || !isTracked(booking.status)) return null;
	const row = await db
		.selectFrom("sd_driver_locations")
		.select(["lat", "lng", "accuracy", "heading", "speed", "at"])
		.where("driver_id", "=", booking.driver_id)
		.where("booking_id", "=", booking.id)
		.where("at", ">=", freshSince())
		.executeTakeFirst();
	return row ? toPosition(row) : null;
}

export interface LiveCar extends Position {
	driverName: string;
	plate: string | null;
	code: string;
	status: BookingStatus;
}

/** Every car on a live trip, for the ops map. */
export async function liveCars(db: Db): Promise<LiveCar[]> {
	const rows = await db
		.selectFrom("sd_driver_locations as l")
		.innerJoin("sd_drivers as d", "d.id", "l.driver_id")
		.innerJoin("sd_bookings as b", "b.id", "l.booking_id")
		.select(["l.lat", "l.lng", "l.accuracy", "l.heading", "l.speed", "l.at", "d.name", "d.plate", "b.code", "b.status"])
		.where("l.at", ">=", freshSince())
		.where("b.status", "in", TRACKED_STATUSES)
		.whereRef("b.driver_id", "=", "l.driver_id")
		.orderBy("l.at", "desc")
		.execute();
	return rows.map((r: { name: string; plate: string | null; code: string; status: BookingStatus } & Parameters<typeof toPosition>[0]) => ({
		...toPosition(r),
		driverName: r.name,
		plate: r.plate,
		code: r.code,
		status: r.status,
	}));
}
