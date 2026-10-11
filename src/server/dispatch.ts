/**
 * Automatic driver assignment: bookings without a driver are offered to drivers one
 * at a time, from `autoAssignHours` before pickup. The driver accepts or declines in
 * the driver app; an offer nobody answers within `offerMinutes` moves to the next
 * driver. When nobody is left, ops gets an alert and assigns by hand as before.
 *
 * Runs from the middleware at most once a minute per isolate, on panel and driver-app
 * requests (the driver job list reloads every minute, ops pages poll), so it needs no
 * separate scheduler. Every booking change is version-checked, so two isolates running
 * at once cannot both offer the same booking.
 */
import type { Db } from "./db";
import { assignDriver, ConflictError, addEvent, type Actor, type Booking } from "./bookings";
import { getSettings } from "./settings";

const SYSTEM: Actor = { kind: "system", userId: null };
/** A driver is busy this long either side of another job's pickup. */
const BUSY_WINDOW_MS = 3 * 3600_000;
/** Bookings handled per run, so one request never does too much. */
const PER_RUN = 10;
const RUN_EVERY_MS = 60_000;

// A timestamp, not a shared promise: see src/server/db/index.ts.
let lastRun = 0;

/** Called on every private request; does the work at most once a minute. */
export async function dispatchIfDue(db: Db): Promise<void> {
	if (Date.now() - lastRun < RUN_EVERY_MS) return;
	lastRun = Date.now();
	try {
		await runDispatch(db);
	} catch (error) {
		console.error("dispatch", error);
	}
}

export interface DispatchResult {
	timedOut: number;
	offered: number;
	unmatched: number;
}

export async function runDispatch(db: Db, now = Date.now()): Promise<DispatchResult> {
	const result: DispatchResult = { timedOut: 0, offered: 0, unmatched: 0 };
	const settings = await getSettings(db);
	if (!settings.autoAssign) return result;

	// 1. Automatic offers nobody answered in time go back to the pool.
	const expired = await db
		.selectFrom("sd_assignments as a")
		.innerJoin("sd_bookings as b", (join) => join.onRef("b.id", "=", "a.booking_id").onRef("b.driver_id", "=", "a.driver_id"))
		.leftJoin("sd_assignment_acks as k", "k.assignment_id", "a.id")
		.leftJoin("sd_drivers as d", "d.id", "a.driver_id")
		.selectAll("b")
		.select(["d.name as driver_name"])
		.where("a.mode", "=", "auto")
		.where("a.status", "=", "accepted")
		.where("k.response", "is", null)
		.where("b.status", "=", "assigned")
		.where("a.created_at", "<", new Date(now - settings.offerMinutes * 60_000).toISOString())
		.limit(PER_RUN)
		.execute();
	for (const row of expired) {
		const { driver_name, ...booking } = row as Booking & { driver_name: string | null };
		try {
			await assignDriver(db, booking, null, SYSTEM);
			await addEvent(db, booking.id, SYSTEM, "offer_timed_out", null, null, { driverId: booking.driver_id, driverName: driver_name });
			result.timedOut++;
		} catch (error) {
			if (!(error instanceof ConflictError)) throw error;
		}
	}

	// 2. Bookings inside the window without a driver get the best free driver.
	const open = (await db
		.selectFrom("sd_bookings")
		.selectAll()
		.where("status", "=", "confirmed")
		.where("driver_id", "is", null)
		.where("pickup_at", ">", new Date(now).toISOString())
		.where("pickup_at", "<=", new Date(now + settings.autoAssignHours * 3600_000).toISOString())
		.orderBy("pickup_at")
		.limit(PER_RUN)
		.execute()) as Booking[];
	for (const booking of open) {
		const driver = await bestDriver(db, booking);
		if (!driver) {
			// Tell ops once per round of offers, not on every run.
			const last = await db
				.selectFrom("sd_booking_events")
				.select("type")
				.where("booking_id", "=", booking.id)
				.where("type", "in", ["auto_offered", "auto_unmatched"])
				.orderBy("at", "desc")
				.executeTakeFirst();
			if (last?.type !== "auto_unmatched") {
				await addEvent(db, booking.id, SYSTEM, "auto_unmatched", null, null, {});
				result.unmatched++;
			}
			continue;
		}
		try {
			await assignDriver(db, booking, driver.id, SYSTEM, "auto");
			await addEvent(db, booking.id, SYSTEM, "auto_offered", null, null, { driverId: driver.id, driverName: driver.name, jobsThatDay: driver.jobs, rating: driver.rating });
			result.offered++;
		} catch (error) {
			if (!(error instanceof ConflictError)) throw error;
		}
	}
	return result;
}

interface Candidate {
	id: string;
	name: string;
	jobs: number;
	rating: number | null;
}

/**
 * Active drivers who can sign in, drive this class, have not been offered this booking
 * before and are free around its pickup. Fewest jobs that day first, then best rated.
 */
export async function bestDriver(db: Db, booking: Booking): Promise<Candidate | null> {
	const pickup = Date.parse(booking.pickup_at);
	const iso = (ms: number) => new Date(ms).toISOString();
	const drivers = await db
		.selectFrom("sd_drivers as d")
		.innerJoin("sd_driver_access as x", "x.driver_id", "d.id")
		.select(["d.id", "d.name"])
		.where("d.status", "=", "active")
		.where((eb) => eb.or([eb("d.class_key", "is", null), eb("d.class_key", "=", booking.class_key)]))
		// Anyone who already had it (declined, timed out, released) is not asked again.
		.where("d.id", "not in", db.selectFrom("sd_assignments").select("driver_id").where("booking_id", "=", booking.id))
		.where(
			"d.id",
			"not in",
			db
				.selectFrom("sd_bookings")
				.select("driver_id")
				.where("driver_id", "is not", null)
				.where("id", "!=", booking.id)
				.where("status", "not in", ["cancelled", "completed", "no_show"])
				.where("pickup_at", ">", iso(pickup - BUSY_WINDOW_MS))
				.where("pickup_at", "<", iso(pickup + BUSY_WINDOW_MS)),
		)
		.execute();
	if (drivers.length === 0) return null;

	// The pickup's day in Istanbul (UTC+3, no daylight saving).
	const dayStart = Math.floor((pickup + 3 * 3600_000) / 86400_000) * 86400_000 - 3 * 3600_000;
	const ids = drivers.map((d) => d.id);
	const [jobs, ratings] = await Promise.all([
		db
			.selectFrom("sd_bookings")
			.select(["driver_id", (eb) => eb.fn.countAll<number>().as("n")])
			.where("driver_id", "in", ids)
			.where("status", "!=", "cancelled")
			.where("pickup_at", ">=", iso(dayStart))
			.where("pickup_at", "<", iso(dayStart + 86400_000))
			.groupBy("driver_id")
			.execute(),
		db
			.selectFrom("sd_reviews")
			.select(["driver_id", (eb) => eb.fn.avg<number>("rating").as("avg")])
			.where("driver_id", "in", ids)
			.groupBy("driver_id")
			.execute(),
	]);
	const jobsOf = new Map(jobs.map((r) => [r.driver_id as string, Number(r.n)]));
	const ratingOf = new Map(ratings.map((r) => [r.driver_id as string, Number(r.avg)]));
	const ranked: Candidate[] = drivers
		.map((d) => ({ id: d.id as string, name: d.name as string, jobs: jobsOf.get(d.id) ?? 0, rating: ratingOf.get(d.id) ?? null }))
		.sort((a, b) => a.jobs - b.jobs || (b.rating ?? 4.5) - (a.rating ?? 4.5) || a.name.localeCompare(b.name, "tr"));
	return ranked[0];
}
