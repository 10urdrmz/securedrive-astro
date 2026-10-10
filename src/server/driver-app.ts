/**
 * The driver app (/surucu): sign-in with phone + PIN, the driver's jobs, accepting or
 * declining an assignment and moving the trip forward step by step.
 *
 * Ops hands out the PIN (Sürücüler page); only its hash is stored. Five wrong PINs lock
 * the driver for 15 minutes; the sign-in page is also rate limited per visitor.
 */
import type { AstroCookies } from "astro";
import type { Db } from "./db";
import { hashPassword, verifyPassword } from "./auth/password";
import { randomToken, sha256Hex } from "./ids";
import { FINAL_STATUSES, addEvent, assignDriver, transition, type Booking, type BookingStatus } from "./bookings";

const COOKIE = "sd_drv";
const COOKIE_PATH = "/surucu";
// Drivers stay signed in on their own phone; ops can sign them out by resetting the PIN.
const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export interface Driver {
	id: string;
	name: string;
	phone: string;
	plate: string | null;
	vehicle: string | null;
	class_key: string | null;
	status: string;
}

const DRIVER_FIELDS = ["d.id", "d.name", "d.phone", "d.plate", "d.vehicle", "d.class_key", "d.status"] as const;

/** Last ten digits: "+90 532 111 22 33", "0532 111 2233" and "5321112233" all match. */
export const phoneKey = (phone: string) => phone.replace(/\D/g, "").slice(-10);

// ---------------------------------------------------------------- access

/** New 6-digit PIN for a driver. Signs the driver out everywhere. Returns the PIN to show once. */
export async function issuePin(db: Db, driverId: string): Promise<string> {
	const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
	const now = new Date().toISOString();
	const pin_hash = await hashPassword(pin);
	await db
		.insertInto("sd_driver_access")
		.values({ driver_id: driverId, pin_hash, failures: 0, locked_until: null, updated_at: now })
		.onConflict((oc) => oc.column("driver_id").doUpdateSet({ pin_hash, failures: 0, locked_until: null, updated_at: now }))
		.execute();
	await db.deleteFrom("sd_driver_sessions").where("driver_id", "=", driverId).execute();
	return pin;
}

export async function revokeAccess(db: Db, driverId: string) {
	await db.deleteFrom("sd_driver_sessions").where("driver_id", "=", driverId).execute();
	await db.deleteFrom("sd_driver_access").where("driver_id", "=", driverId).execute();
}

/** Driver ids that can sign in, for the ops list. */
export async function driversWithAccess(db: Db): Promise<Set<string>> {
	const rows = await db.selectFrom("sd_driver_access").select("driver_id").execute();
	return new Set(rows.map((r: { driver_id: string }) => r.driver_id));
}

export type SignInResult = { ok: true; driverId: string } | { ok: false; error: "invalid" | "locked" };

/** Why a sign-in ended as it did. The driver only ever sees "wrong phone or PIN"; ops sees this. */
export type LoginOutcome = "ok" | "bad_input" | "unknown_phone" | "inactive" | "no_pin" | "wrong_pin" | "locked";

export const LOGIN_OUTCOME_LABELS: Record<LoginOutcome, string> = {
	ok: "Giriş yaptı",
	bad_input: "Telefon veya PIN biçimi hatalı",
	unknown_phone: "Bu telefonla kayıtlı sürücü yok",
	inactive: "Sürücü pasif",
	no_pin: "Sürücüye PIN verilmemiş",
	wrong_pin: "PIN yanlış",
	locked: "Çok fazla yanlış PIN, kilitli",
};

async function logLogin(db: Db, phone: string, driverId: string | null, result: LoginOutcome) {
	const now = new Date();
	await db
		.insertInto("sd_driver_login_log")
		.values({ at: now.toISOString(), phone_tail: phone.replace(/\D/g, "").slice(-4), driver_id: driverId, result })
		.execute();
	await db
		.deleteFrom("sd_driver_login_log")
		.where("at", "<", new Date(now.getTime() - 30 * 86400_000).toISOString())
		.execute();
}

/** Latest sign-in attempts, newest first, for the ops drivers page. */
export async function recentLogins(db: Db, limit = 15) {
	return db
		.selectFrom("sd_driver_login_log as l")
		.leftJoin("sd_drivers as d", "d.id", "l.driver_id")
		.select(["l.at", "l.phone_tail", "l.result", "d.name"])
		.orderBy("l.id", "desc")
		.limit(limit)
		.execute() as Promise<{ at: string; phone_tail: string; result: LoginOutcome; name: string | null }[]>;
}

export async function checkPin(db: Db, phone: string, pin: string): Promise<SignInResult> {
	const outcome = await matchPin(db, phone, pin);
	await logLogin(db, phone, outcome.driverId, outcome.result);
	if (outcome.result === "ok") return { ok: true, driverId: outcome.driverId! };
	return { ok: false, error: outcome.result === "locked" ? "locked" : "invalid" };
}

async function matchPin(db: Db, phone: string, pin: string): Promise<{ result: LoginOutcome; driverId: string | null }> {
	const key = phoneKey(phone);
	if (key.length < 10 || !/^\d{6}$/.test(pin)) return { result: "bad_input", driverId: null };
	const candidates = await db
		.selectFrom("sd_drivers as d")
		.leftJoin("sd_driver_access as a", "a.driver_id", "d.id")
		.select(["d.id", "d.phone", "d.status", "a.pin_hash", "a.failures", "a.locked_until"])
		.execute();
	const matches = candidates.filter((c: { phone: string }) => phoneKey(c.phone) === key);
	// Several records can share a number (an old inactive one, say): prefer the one that can sign in.
	const row = matches.find((c: { status: string; pin_hash: string | null }) => c.status === "active" && c.pin_hash) ?? matches[0];
	if (!row) return { result: "unknown_phone", driverId: null };
	if (row.status !== "active") return { result: "inactive", driverId: row.id };
	if (!row.pin_hash) return { result: "no_pin", driverId: row.id };
	const now = new Date();
	if (row.locked_until && row.locked_until > now.toISOString()) return { result: "locked", driverId: row.id };
	// Two active drivers on one number: the PIN tells them apart.
	for (const c of matches.filter((m: { status: string; pin_hash: string | null }) => m.status === "active" && m.pin_hash)) {
		if (!(await verifyPassword(pin, c.pin_hash))) continue;
		await db.updateTable("sd_driver_access").set({ failures: 0, locked_until: null }).where("driver_id", "=", c.id).execute();
		return { result: "ok", driverId: c.id };
	}
	const failures = Number(row.failures) + 1;
	const locked = failures >= MAX_FAILURES;
	await db
		.updateTable("sd_driver_access")
		.set({ failures: locked ? 0 : failures, locked_until: locked ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null })
		.where("driver_id", "=", row.id)
		.execute();
	return { result: locked ? "locked" : "wrong_pin", driverId: row.id };
}

// ---------------------------------------------------------------- sessions

export async function startSession(db: Db, cookies: AstroCookies, driverId: string, userAgent: string | null) {
	const token = randomToken();
	const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
	await db
		.insertInto("sd_driver_sessions")
		.values({ token_hash: await sha256Hex(token), driver_id: driverId, user_agent: userAgent?.slice(0, 300) ?? null, expires_at: expires.toISOString() })
		.execute();
	cookies.set(COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: COOKIE_PATH, expires });
}

export async function sessionDriver(db: Db, cookies: AstroCookies): Promise<Driver | null> {
	const token = cookies.get(COOKIE)?.value;
	if (!token) return null;
	const row = await db
		.selectFrom("sd_driver_sessions as s")
		.innerJoin("sd_drivers as d", "d.id", "s.driver_id")
		.select([...DRIVER_FIELDS, "s.expires_at"])
		.where("s.token_hash", "=", await sha256Hex(token))
		.executeTakeFirst();
	if (!row || row.status !== "active" || row.expires_at < new Date().toISOString()) return null;
	return row as Driver;
}

export async function endSession(db: Db, cookies: AstroCookies) {
	const token = cookies.get(COOKIE)?.value;
	if (token)
		await db
			.deleteFrom("sd_driver_sessions")
			.where("token_hash", "=", await sha256Hex(token))
			.execute();
	cookies.delete(COOKIE, { path: COOKIE_PATH });
}

// ---------------------------------------------------------------- jobs

/** The one step the driver can take next, in the order of a trip. */
export const DRIVER_STEPS: Partial<Record<BookingStatus, { to: BookingStatus; label: string }[]>> = {
	assigned: [{ to: "driver_en_route", label: "Yola çıktım" }],
	driver_en_route: [{ to: "driver_arrived", label: "Alış noktasına vardım" }],
	driver_arrived: [
		{ to: "on_board", label: "Yolcu araçta" },
		{ to: "no_show", label: "Yolcu gelmedi" },
	],
	on_board: [{ to: "completed", label: "Yolculuk bitti" }],
};

export interface DriverJob {
	booking: Booking;
	assignmentId: string | null;
	/** null: the driver has not answered yet. */
	response: "accepted" | "declined" | null;
	fromName: string;
	toName: string;
	className: string;
}

function jobsQuery(db: Db, driverId: string) {
	return db
		.selectFrom("sd_bookings as b")
		.leftJoin("sd_zones as f", "f.id", "b.from_zone_id")
		.leftJoin("sd_zones as t", "t.id", "b.to_zone_id")
		.leftJoin("sd_vehicle_classes as c", "c.key", "b.class_key")
		.leftJoin("sd_assignments as a", (join) =>
			join.onRef("a.booking_id", "=", "b.id").on("a.driver_id", "=", driverId).on("a.status", "in", ["accepted", "done"]),
		)
		.leftJoin("sd_assignment_acks as k", "k.assignment_id", "a.id")
		.selectAll("b")
		.select(["f.name as from_name", "t.name as to_name", "c.name as class_name", "a.id as assignment_id", "k.response as response"])
		.where("b.driver_id", "=", driverId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJob = (row: any): DriverJob => {
	const { from_name, to_name, class_name, assignment_id, response, ...booking } = row;
	return {
		booking: booking as Booking,
		assignmentId: assignment_id ?? null,
		response: response ?? null,
		fromName: from_name ?? "",
		toName: to_name ?? "",
		className: class_name ?? booking.class_key,
	};
};

/** Open jobs (soonest first) and the last few days' finished ones. */
export async function driverJobs(db: Db, driverId: string): Promise<{ open: DriverJob[]; done: DriverJob[] }> {
	const since = new Date(Date.now() - 3 * 86400_000).toISOString();
	const rows = (
		await jobsQuery(db, driverId).where("b.status", "!=", "cancelled").where("b.pickup_at", ">=", since).orderBy("b.pickup_at").limit(200).execute()
	).map(toJob);
	return {
		open: rows.filter((j) => !FINAL_STATUSES.includes(j.booking.status)),
		done: rows.filter((j) => FINAL_STATUSES.includes(j.booking.status)).reverse(),
	};
}

export async function driverJob(db: Db, driverId: string, code: string): Promise<DriverJob | null> {
	const row = await jobsQuery(db, driverId).where("b.code", "=", code).executeTakeFirst();
	return row ? toJob(row) : null;
}

const actor = { kind: "driver" as const, userId: null };

/** Accept or decline. Declining hands the booking back to ops unassigned. */
export async function respond(db: Db, job: DriverJob, driver: Driver, response: "accepted" | "declined") {
	if (!job.assignmentId || job.response) return;
	await db.insertInto("sd_assignment_acks").values({ assignment_id: job.assignmentId, response, at: new Date().toISOString() }).execute();
	if (response === "declined") await assignDriver(db, job.booking, null, actor);
	await addEvent(db, job.booking.id, actor, response === "accepted" ? "driver_accepted" : "driver_declined", job.booking.status, null, {
		driverId: driver.id,
		driverName: driver.name,
	});
}

/** One step of the trip. Starting the trip also counts as accepting it. */
export async function driverStep(db: Db, job: DriverJob, driver: Driver, to: BookingStatus) {
	const allowed = DRIVER_STEPS[job.booking.status]?.some((s) => s.to === to);
	if (!allowed) throw new Error("Bu adım şu an yapılamaz.");
	if (to === "no_show" && Date.now() < Date.parse(job.booking.pickup_at)) throw new Error("Alış saati gelmeden 'yolcu gelmedi' denemez.");
	if (!job.response && job.assignmentId) await respond(db, job, driver, "accepted");
	await transition(db, job.booking, to, actor);
}

// ---------------------------------------------------------------- display

const DAY = new Intl.DateTimeFormat("tr-TR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Bugün", "Yarın" or "Cum 16 Eki", plus the Istanbul time. */
export function when(iso: string): { day: string; time: string } {
	const local = new Date(Date.parse(iso) + 3 * 3600_000);
	const today = new Date(Date.now() + 3 * 3600_000);
	const days = Math.round(
		(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
			86400_000,
	);
	const day = days === 0 ? "Bugün" : days === 1 ? "Yarın" : days === -1 ? "Dün" : DAY.format(local);
	return { day, time: local.toISOString().slice(11, 16) };
}

/** Badge for a job as the driver sees it. */
export function jobBadge(job: DriverJob): { label: string; tone: "warn" | "info" | "ok" | "off" } {
	const s = job.booking.status;
	if (s === "assigned") return job.response === "accepted" ? { label: "Kabul edildi", tone: "info" } : { label: "Onayınızı bekliyor", tone: "warn" };
	if (s === "driver_en_route") return { label: "Yoldasınız", tone: "info" };
	if (s === "driver_arrived") return { label: "Alış noktasındasınız", tone: "info" };
	if (s === "on_board") return { label: "Yolculuk sürüyor", tone: "info" };
	if (s === "completed") return { label: "Tamamlandı", tone: "ok" };
	if (s === "no_show") return { label: "Yolcu gelmedi", tone: "off" };
	return { label: s, tone: "info" };
}
