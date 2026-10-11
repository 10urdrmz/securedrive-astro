/**
 * Flight tracking for airport pickups: the passenger's arriving flight, so the
 * driver knows when to be at the door and everyone sees delays.
 *
 * Status comes from AeroDataBox (via RapidAPI) when FLIGHT_API_KEY is set, checked
 * more often as the landing gets closer. Without a key, or whenever ops know better,
 * ops set the status and expected time by hand on the booking page; a hand-set
 * status is never overwritten by the automatic check.
 *
 * Secrets (wrangler secret put …, or .env locally):
 *   FLIGHT_API_KEY    RapidAPI key with an AeroDataBox subscription
 *   FLIGHT_API_HOST   optional, defaults to aerodatabox.p.rapidapi.com
 *
 * Runs from the middleware at most once a minute, like server/dispatch.ts.
 */
import type { Db } from "./db";
import { addEvent, type Actor, type Booking } from "./bookings";
import { isoToIstanbul } from "./pricing";

export const FLIGHT_STATUSES = ["scheduled", "delayed", "airborne", "landed", "cancelled", "diverted", "unknown"] as const;
export type FlightStatus = (typeof FLIGHT_STATUSES)[number];

export const FLIGHT_STATUS_LABELS: Record<FlightStatus, string> = {
	scheduled: "Planlandığı gibi",
	delayed: "Rötarlı",
	airborne: "Havada",
	landed: "İndi",
	cancelled: "İptal",
	diverted: "Başka havalimanına yöneldi",
	unknown: "Bilgi yok",
};

export interface Flight {
	booking_id: string;
	flight_no: string;
	status: FlightStatus;
	scheduled_at: string | null;
	estimated_at: string | null;
	actual_at: string | null;
	terminal: string | null;
	gate: string | null;
	belt: string | null;
	source: "api" | "manual";
	checked_at: string | null;
	error: string | null;
	updated_at: string;
}

/** What a page shows: the best time we have and how late it is. */
export interface FlightView {
	flightNo: string;
	status: FlightStatus;
	/** Landing time: actual once landed, else expected, else scheduled. */
	at: string | null;
	scheduledAt: string | null;
	/** Minutes behind schedule (only when 5 or more). */
	delayMin: number;
	terminal: string | null;
	belt: string | null;
	source: "api" | "manual";
	checkedAt: string | null;
}

const SYSTEM: Actor = { kind: "system", userId: null };
const RUN_EVERY_MS = 60_000;
const PER_RUN = 3;
/** Bookings in these states still need their flight watched. */
const WATCHED = ["confirmed", "assigned", "driver_en_route", "driver_arrived"];

export const flightApiEnabled = () => !!process.env.FLIGHT_API_KEY;

/** "tk 1984" → "TK1984". Null when it does not look like a flight number. */
export function normalizeFlightNo(value: string | null | undefined): string | null {
	const compact = (value ?? "").toUpperCase().replace(/[\s-]/g, "");
	return /^[A-Z0-9]{2}[A-Z]?\d{1,5}[A-Z]?$/.test(compact) ? compact : null;
}

/** IATA code from an airport zone's name, e.g. "İstanbul Havalimanı (IST)". */
export const airportCode = (zoneName: string | null | undefined) => /\(([A-Z]{3})\)/.exec(zoneName ?? "")?.[1] ?? null;

export function flightView(flight: Flight | null | undefined): FlightView | null {
	if (!flight) return null;
	const at = flight.actual_at ?? flight.estimated_at ?? flight.scheduled_at;
	const delay = flight.scheduled_at && at ? Math.round((Date.parse(at) - Date.parse(flight.scheduled_at)) / 60_000) : 0;
	return {
		flightNo: flight.flight_no,
		status: flight.status,
		at,
		scheduledAt: flight.scheduled_at,
		delayMin: delay >= 5 ? delay : 0,
		terminal: flight.terminal,
		belt: flight.belt,
		source: flight.source,
		checkedAt: flight.checked_at,
	};
}

export async function getFlight(db: Db, bookingId: string): Promise<Flight | null> {
	return ((await db.selectFrom("sd_flights").selectAll().where("booking_id", "=", bookingId).executeTakeFirst()) as Flight | undefined) ?? null;
}

type FlightUpdate = Pick<Flight, "status" | "scheduled_at" | "estimated_at" | "actual_at" | "terminal" | "gate" | "belt">;

/** Store a new reading and log it in the booking's history when something changed that people care about. */
async function saveFlight(db: Db, booking: Booking, flightNo: string, update: FlightUpdate, source: Flight["source"], actor: Actor, error: string | null = null) {
	const before = await getFlight(db, booking.id);
	const now = new Date().toISOString();
	const row = { ...update, flight_no: flightNo, source, checked_at: now, error, updated_at: now };
	await db
		.insertInto("sd_flights")
		.values({ booking_id: booking.id, ...row })
		.onConflict((oc) => oc.column("booking_id").doUpdateSet(row))
		.execute();
	const view = flightView({ ...(before ?? {}), booking_id: booking.id, ...row } as Flight)!;
	const prev = flightView(before);
	const shifted = Math.abs((view.at ? Date.parse(view.at) : 0) - (prev?.at ? Date.parse(prev.at) : 0)) >= 15 * 60_000;
	if (!prev || prev.status !== view.status || (shifted && !!prev.at)) {
		await addEvent(db, booking.id, actor, "flight_update", null, null, {
			flightNo,
			status: view.status,
			at: view.at,
			delayMin: view.delayMin,
			source,
		});
	}
}

/** Ops set the flight's status by hand. `at` is the expected or actual landing time (ISO). */
export async function setFlightManually(db: Db, booking: Booking, actor: Actor, status: FlightStatus, at: string | null) {
	const flightNo = normalizeFlightNo(booking.flight_no) ?? (booking.flight_no ?? "").trim();
	if (!flightNo) return;
	const before = await getFlight(db, booking.id);
	await saveFlight(
		db,
		booking,
		flightNo,
		{
			status,
			// Without a source, the booked pickup time is the planned landing.
			scheduled_at: before?.scheduled_at ?? booking.pickup_at,
			estimated_at: status === "landed" ? (before?.estimated_at ?? null) : at,
			actual_at: status === "landed" ? at : null,
			terminal: before?.terminal ?? null,
			gate: before?.gate ?? null,
			belt: before?.belt ?? null,
		},
		"manual",
		actor,
	);
}

/** Hand the flight back to the automatic check (and check it now). */
export async function resumeAutomaticFlight(db: Db, booking: Booking, airport: string | null) {
	await db.updateTable("sd_flights").set({ source: "api", checked_at: null }).where("booking_id", "=", booking.id).execute();
	if (flightApiEnabled()) await checkFlight(db, booking, airport);
}

// ---------------------------------------------------------------------------
// Automatic checks

// A timestamp, not a shared promise: see src/server/db/index.ts.
let lastRun = 0;

export async function refreshFlightsIfDue(db: Db): Promise<void> {
	if (!flightApiEnabled() || Date.now() - lastRun < RUN_EVERY_MS) return;
	lastRun = Date.now();
	try {
		await refreshFlights(db);
	} catch (error) {
		console.error("flights", error);
	}
}

/** How long a reading stays fresh: hourly while far off, every 5 minutes around landing. */
function freshFor(pickupAt: string, now: number) {
	const until = Date.parse(pickupAt) - now;
	if (until > 6 * 3600_000) return 60 * 60_000;
	if (until > 90 * 60_000) return 15 * 60_000;
	return 5 * 60_000;
}

export async function refreshFlights(db: Db, now = Date.now()): Promise<number> {
	const rows = (await db
		.selectFrom("sd_bookings as b")
		.innerJoin("sd_zones as z", "z.id", "b.from_zone_id")
		.leftJoin("sd_flights as f", "f.booking_id", "b.id")
		.selectAll("b")
		.select(["z.name as airport_name", "f.checked_at as flight_checked_at", "f.status as flight_status", "f.source as flight_source"])
		.where("z.kind", "=", "airport")
		.where("b.flight_no", "is not", null)
		.where("b.status", "in", WATCHED)
		.where("b.pickup_at", ">", new Date(now - 4 * 3600_000).toISOString())
		.where("b.pickup_at", "<", new Date(now + 24 * 3600_000).toISOString())
		.orderBy("f.checked_at")
		.limit(40)
		.execute()) as (Booking & { airport_name: string; flight_checked_at: string | null; flight_status: string | null; flight_source: string | null })[];
	let checked = 0;
	for (const row of rows) {
		if (checked >= PER_RUN) break;
		if (row.flight_source === "manual") continue;
		if (row.flight_status === "landed" || row.flight_status === "cancelled") continue;
		if (row.flight_checked_at && now - Date.parse(row.flight_checked_at) < freshFor(row.pickup_at, now)) continue;
		const { airport_name, flight_checked_at: _c, flight_status: _s, flight_source: _o, ...booking } = row;
		await checkFlight(db, booking as Booking, airportCode(airport_name));
		checked++;
	}
	return checked;
}

/** Ask the provider about one booking's flight and store the answer. */
export async function checkFlight(db: Db, booking: Booking, airport: string | null): Promise<void> {
	const flightNo = normalizeFlightNo(booking.flight_no);
	if (!flightNo) return;
	const before = await getFlight(db, booking.id);
	try {
		const update = await fetchArrival(flightNo, isoToIstanbul(booking.pickup_at).date, airport);
		await saveFlight(db, booking, flightNo, update ?? { ...emptyUpdate(before), status: before?.status ?? "unknown" }, "api", SYSTEM, update ? null : "not_found");
	} catch (error) {
		// Keep the last good reading; note the failure so ops can see it.
		await saveFlight(db, booking, flightNo, { ...emptyUpdate(before), status: before?.status ?? "unknown" }, "api", SYSTEM, String(error).slice(0, 200));
	}
}

const emptyUpdate = (before: Flight | null): FlightUpdate => ({
	status: before?.status ?? "unknown",
	scheduled_at: before?.scheduled_at ?? null,
	estimated_at: before?.estimated_at ?? null,
	actual_at: before?.actual_at ?? null,
	terminal: before?.terminal ?? null,
	gate: before?.gate ?? null,
	belt: before?.belt ?? null,
});

interface AdbTime {
	utc?: string;
}
interface AdbLeg {
	status?: string;
	arrival?: {
		airport?: { iata?: string };
		scheduledTime?: AdbTime;
		revisedTime?: AdbTime;
		predictedTime?: AdbTime;
		runwayTime?: AdbTime;
		terminal?: string;
		gate?: string;
		baggageBelt?: string;
	};
}

/** AeroDataBox writes "2026-10-13 01:30Z". */
const utc = (time?: AdbTime) => {
	if (!time?.utc) return null;
	const parsed = Date.parse(time.utc.replace(" ", "T"));
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const ADB_STATUS: Record<string, FlightStatus> = {
	Expected: "scheduled",
	CheckIn: "scheduled",
	Boarding: "scheduled",
	GateClosed: "scheduled",
	Departed: "airborne",
	EnRoute: "airborne",
	Approaching: "airborne",
	Delayed: "delayed",
	Arrived: "landed",
	Canceled: "cancelled",
	CanceledUncertain: "cancelled",
	Diverted: "diverted",
};

async function fetchArrival(flightNo: string, date: string, airport: string | null): Promise<FlightUpdate | null> {
	const host = process.env.FLIGHT_API_HOST || "aerodatabox.p.rapidapi.com";
	const url = `https://${host}/flights/number/${encodeURIComponent(flightNo)}/${date}?withAircraftImage=false&withLocation=false&dateLocalRole=Arrival`;
	const response = await fetch(url, {
		headers: { "x-rapidapi-key": process.env.FLIGHT_API_KEY ?? "", "x-rapidapi-host": host },
		signal: AbortSignal.timeout(8000),
	});
	if (response.status === 204 || response.status === 404) return null;
	if (!response.ok) throw new Error(`flight api ${response.status}`);
	const legs = (await response.json()) as AdbLeg[];
	const leg = (Array.isArray(legs) ? legs : []).find((l) => !airport || l.arrival?.airport?.iata === airport) ?? null;
	if (!leg?.arrival) return null;
	const a = leg.arrival;
	const scheduled = utc(a.scheduledTime);
	const estimated = utc(a.revisedTime) ?? utc(a.predictedTime);
	let status = ADB_STATUS[leg.status ?? ""] ?? "unknown";
	const actual = status === "landed" ? (utc(a.runwayTime) ?? estimated) : null;
	if (status === "scheduled" && scheduled && estimated && Date.parse(estimated) - Date.parse(scheduled) >= 15 * 60_000) status = "delayed";
	return {
		status,
		scheduled_at: scheduled,
		estimated_at: estimated,
		actual_at: actual,
		terminal: a.terminal ?? null,
		gate: a.gate ?? null,
		belt: a.baggageBelt ?? null,
	};
}
