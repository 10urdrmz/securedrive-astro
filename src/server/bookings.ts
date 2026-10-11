/**
 * Bookings: creation, the status machine, manual driver assignment and payments.
 *
 * Every change goes through `transition()` / `assignDriver()` so it is version-checked
 * (two dispatchers cannot overwrite each other) and leaves a row in sd_booking_events.
 * Bookings hold personal data: never render them on a public, cacheable page.
 */
import { sql } from "kysely";
import type { Db } from "./db";
import { randomToken, ulid } from "./ids";
import type { ClassQuote, Quote } from "./pricing";

export const BOOKING_STATUSES = [
	"quoted",
	"pending_payment",
	"confirmed",
	"assigned",
	"driver_en_route",
	"driver_arrived",
	"on_board",
	"completed",
	"no_show",
	"cancelled",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const STATUS_LABELS: Record<BookingStatus, string> = {
	quoted: "Teklif, müşteri onayı bekleniyor",
	pending_payment: "Ödeme bekleniyor",
	confirmed: "Onaylandı",
	assigned: "Sürücü atandı",
	driver_en_route: "Sürücü yolda",
	driver_arrived: "Sürücü vardı",
	on_board: "Yolcu araçta",
	completed: "Tamamlandı",
	no_show: "Yolcu gelmedi",
	cancelled: "İptal",
};

/** Statuses after which nothing more happens to the trip itself. */
export const FINAL_STATUSES: BookingStatus[] = ["completed", "no_show", "cancelled"];

/** What ops may move a booking to from each status (assignment has its own action). */
export const OPS_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
	// A quote becomes a booking only when the customer accepts it; ops can withdraw it.
	quoted: ["cancelled"],
	pending_payment: ["confirmed", "cancelled"],
	confirmed: ["cancelled"],
	assigned: ["driver_en_route", "driver_arrived", "on_board", "completed", "cancelled"],
	driver_en_route: ["driver_arrived", "on_board", "completed", "cancelled"],
	driver_arrived: ["on_board", "completed", "no_show"],
	on_board: ["completed"],
	completed: [],
	no_show: [],
	cancelled: [],
};

export const PAYMENT_METHODS = ["cash", "card_in_vehicle", "account", "online"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
	cash: "Araçta nakit",
	card_in_vehicle: "Araçta kart",
	account: "Cari hesap",
	online: "Online kart",
};
export const PAYMENT_STATUS_LABELS: Record<string, string> = {
	unpaid: "Tahsil edilmedi",
	paid: "Tahsil edildi",
	refunded: "İade edildi",
	partially_refunded: "Kısmi iade",
};

export interface Booking {
	id: string;
	code: string;
	status: BookingStatus;
	version: number;
	source: string;
	locale: string;
	customer_member_id: string | null;
	from_zone_id: string;
	to_zone_id: string;
	pickup_address: string | null;
	dropoff_address: string | null;
	pickup_at: string;
	flight_no: string | null;
	pax: number;
	bags: number;
	class_key: string;
	contact_name: string;
	contact_phone: string;
	contact_email: string | null;
	sign_name: string | null;
	notes: string | null;
	internal_notes: string | null;
	price_minor: number;
	currency: string;
	breakdown: string;
	payout_minor: number | null;
	payment_method: PaymentMethod;
	payment_status: string;
	driver_id: string | null;
	cancel_reason: string | null;
	refund_pct: number | null;
	tracking_token: string;
	created_at: string;
	updated_at: string;
}

/** Who did it: an ops user, the passenger (through the site), the driver (through the driver app) or the system. */
export interface Actor {
	kind: "ops" | "passenger" | "driver" | "system";
	userId?: string | null;
}

/** "2610" for October 2026, Istanbul time. */
function period(now: Date): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "2-digit", month: "2-digit" }).formatToParts(now);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
	return `${part("year")}${part("month")}`;
}

/**
 * Next SD-YYMM-NNNN. Bookings share the monthly counter with transfer requests
 * (plugins/inquiries/src/reference.ts), so a number is never used twice.
 */
export async function nextBookingCode(db: Db, now = new Date()): Promise<string> {
	const yymm = period(now);
	const row = await db
		.insertInto("sd_counters")
		.values({ key: `inquiries:${yymm}`, value: 1 })
		.onConflict((oc) => oc.column("key").doUpdateSet((eb) => ({ value: eb("value", "+", 1) })))
		.returning("value")
		.executeTakeFirstOrThrow();
	return `SD-${yymm}-${String(row.value).padStart(4, "0")}`;
}

export interface NewBooking {
	quote: Quote;
	option: ClassQuote;
	contact: { name: string; phone: string; email: string | null };
	flightNo: string | null;
	signName: string | null;
	pickupAddress: string | null;
	dropoffAddress: string | null;
	notes: string | null;
	pax: number;
	bags: number;
	paymentMethod: PaymentMethod;
	source: "web" | "ops";
	locale: string;
	memberId: string | null;
	/** Ops may agree a different price on the phone. */
	priceOverrideMinor?: number | null;
	internalNotes?: string | null;
	/** Send it to the customer as a quote: it becomes a booking when they accept it. */
	asQuote?: boolean;
}

export async function createBooking(db: Db, input: NewBooking, actor: Actor): Promise<Booking> {
	const id = ulid();
	const code = await nextBookingCode(db);
	const lines = input.option.lines;
	const price = input.priceOverrideMinor ?? input.option.total_minor;
	const breakdown =
		input.priceOverrideMinor != null && input.priceOverrideMinor !== input.option.total_minor
			? [...lines, { kind: "adjustment", label: "Operasyon fiyat düzeltmesi", amount_minor: input.priceOverrideMinor - input.option.total_minor }]
			: lines;
	const now = new Date().toISOString();
	// Online payments confirm the booking only when iyzico reports the money taken.
	const status: BookingStatus = input.asQuote ? "quoted" : input.paymentMethod === "online" ? "pending_payment" : "confirmed";
	const row = {
		id,
		code,
		status,
		version: 1,
		source: input.source,
		locale: input.locale,
		customer_member_id: input.memberId,
		org_id: "",
		from_zone_id: input.quote.from.id,
		to_zone_id: input.quote.to.id,
		pickup_address: input.pickupAddress,
		dropoff_address: input.dropoffAddress,
		pickup_at: input.quote.pickupAt,
		flight_no: input.flightNo,
		pax: input.pax,
		bags: input.bags,
		class_key: input.option.classKey,
		contact_name: input.contact.name,
		contact_phone: input.contact.phone,
		contact_email: input.contact.email,
		sign_name: input.signName,
		notes: input.notes,
		internal_notes: input.internalNotes ?? null,
		price_minor: price,
		currency: "TRY",
		breakdown: JSON.stringify(breakdown),
		payout_minor: input.option.payout_minor,
		payment_method: input.paymentMethod,
		payment_status: "unpaid",
		tracking_token: randomToken(18),
		created_by: actor.userId ?? null,
		created_at: now,
		updated_at: now,
	};
	await db.insertInto("sd_bookings").values(row).execute();
	for (const line of lines) {
		if (line.kind !== "extra" || !line.key) continue;
		await db
			.insertInto("sd_booking_extras")
			.values({ booking_id: id, extra_key: line.key, name: line.label, qty: line.qty ?? 1, price_minor: line.amount_minor })
			.execute();
	}
	await addEvent(db, id, actor, "created", null, status, { source: input.source, price_minor: price });
	return { ...row, cancel_reason: null, refund_pct: null, driver_id: null } as Booking;
}

export async function addEvent(
	db: Db,
	bookingId: string,
	actor: Actor,
	type: string,
	fromStatus: string | null,
	toStatus: string | null,
	data: unknown = {},
) {
	await db
		.insertInto("sd_booking_events")
		.values({
			id: ulid(),
			booking_id: bookingId,
			actor_user_id: actor.userId ?? null,
			actor: actor.kind,
			type,
			from_status: fromStatus,
			to_status: toStatus,
			data: JSON.stringify(data),
		})
		.execute();
}

export class ConflictError extends Error {
	constructor() {
		super("Booking changed in the meantime");
	}
}

/**
 * Version-checked update. Throws ConflictError when someone else changed the booking
 * since it was read; the page reloads and shows the current state.
 */
async function updateBooking(db: Db, booking: Booking, changes: Record<string, unknown>) {
	const result = await db
		.updateTable("sd_bookings")
		.set({ ...changes, version: booking.version + 1, updated_at: new Date().toISOString() })
		.where("id", "=", booking.id)
		.where("version", "=", booking.version)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows ?? 0) !== 1) throw new ConflictError();
}

export async function transition(
	db: Db,
	booking: Booking,
	to: BookingStatus,
	actor: Actor,
	extra: { reason?: string; refundPct?: number } = {},
) {
	if (actor.kind === "ops" && !OPS_TRANSITIONS[booking.status].includes(to)) throw new Error(`Geçersiz geçiş: ${booking.status} → ${to}`);
	const changes: Record<string, unknown> = { status: to };
	if (to === "cancelled") {
		changes.cancel_reason = extra.reason ?? null;
		changes.refund_pct = extra.refundPct ?? null;
	}
	await updateBooking(db, booking, changes);
	if (booking.driver_id && (to === "completed" || to === "no_show")) {
		await db
			.updateTable("sd_assignments")
			.set({ status: "done", ended_at: new Date().toISOString() })
			.where("booking_id", "=", booking.id)
			.where("status", "=", "accepted")
			.execute();
	}
	if (booking.driver_id && to === "cancelled") {
		await db
			.updateTable("sd_assignments")
			.set({ status: "released", ended_at: new Date().toISOString() })
			.where("booking_id", "=", booking.id)
			.where("status", "=", "accepted")
			.execute();
	}
	await addEvent(db, booking.id, actor, "status_change", booking.status, to, extra);
}

/** Manual assignment by ops. Re-assigning ends the previous driver's assignment. */
export async function assignDriver(db: Db, booking: Booking, driverId: string | null, actor: Actor, mode: "manual" | "auto" = "manual") {
	if (FINAL_STATUSES.includes(booking.status)) throw new Error("Kapanmış bir rezervasyona atama yapılamaz.");
	if (booking.status === "quoted") throw new Error("Müşteri teklifi onaylamadan sürücü atanamaz.");
	const now = new Date().toISOString();
	await updateBooking(db, booking, {
		driver_id: driverId,
		status: driverId ? (booking.status === "confirmed" || booking.status === "pending_payment" ? "assigned" : booking.status) : "confirmed",
	});
	await db
		.updateTable("sd_assignments")
		.set({ status: driverId ? "reassigned" : "released", ended_at: now })
		.where("booking_id", "=", booking.id)
		.where("status", "=", "accepted")
		.execute();
	if (driverId) {
		await db
			.insertInto("sd_assignments")
			.values({ id: ulid(), booking_id: booking.id, driver_id: driverId, status: "accepted", mode, payout_minor: booking.payout_minor, assigned_by: actor.userId ?? null })
			.execute();
	}
	await addEvent(db, booking.id, actor, driverId ? "assigned" : "unassigned", booking.status, driverId ? "assigned" : "confirmed", { driverId });
}

/** Ops records money collected (cash or card in the vehicle) or refunded. */
export async function recordPayment(
	db: Db,
	booking: Booking,
	input: { kind: "charge" | "refund"; amountMinor: number; method: string; note: string | null },
	actor: Actor,
) {
	await db
		.insertInto("sd_payments")
		.values({
			id: ulid(),
			booking_id: booking.id,
			provider: "manual",
			method: input.method,
			kind: input.kind,
			amount_minor: input.amountMinor,
			status: "captured",
			recorded_by: actor.userId ?? null,
			note: input.note,
		})
		.execute();
	const totals = await db
		.selectFrom("sd_payments")
		.select([
			sql<number>`coalesce(sum(case when kind = 'charge' then amount_minor else 0 end), 0)`.as("charged"),
			sql<number>`coalesce(sum(case when kind = 'refund' then amount_minor else 0 end), 0)`.as("refunded"),
		])
		.where("booking_id", "=", booking.id)
		.executeTakeFirstOrThrow();
	const charged = Number(totals.charged);
	const refunded = Number(totals.refunded);
	const status = refunded > 0 ? (refunded >= charged ? "refunded" : "partially_refunded") : charged >= booking.price_minor ? "paid" : "unpaid";
	await updateBooking(db, booking, { payment_status: status });
	await addEvent(db, booking.id, actor, input.kind === "charge" ? "payment" : "refund", null, null, {
		amount_minor: input.amountMinor,
		method: input.method,
		note: input.note,
	});
}

export async function getBookingByCode(db: Db, code: string): Promise<Booking | undefined> {
	return (await db.selectFrom("sd_bookings").selectAll().where("code", "=", code.toUpperCase()).executeTakeFirst()) as Booking | undefined;
}

/** Bookings a site member made while signed in, newest pickup first. */
export async function memberBookings(db: Db, memberId: string): Promise<Booking[]> {
	return (await db
		.selectFrom("sd_bookings")
		.selectAll()
		.where("customer_member_id", "=", memberId)
		.orderBy("pickup_at", "desc")
		.limit(50)
		.execute()) as Booking[];
}

/** Compare a secret without leaking how much of it matched through timing. */
export function sameSecret(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * An online payment came back successful: record it and confirm the booking.
 * Safe to call twice for the same payment (a reloaded callback): the second call does nothing.
 */
export async function confirmOnlinePayment(
	db: Db,
	bookingId: string,
	payment: { provider: string; providerRef: string; amountMinor: number; currency: string },
): Promise<Booking | undefined> {
	const existing = await db.selectFrom("sd_payments").select("id").where("provider", "=", payment.provider).where("provider_ref", "=", payment.providerRef).executeTakeFirst();
	let booking = (await db.selectFrom("sd_bookings").selectAll().where("id", "=", bookingId).executeTakeFirst()) as Booking | undefined;
	if (!booking || existing) return booking;
	const system: Actor = { kind: "system" };
	await db
		.insertInto("sd_payments")
		.values({
			id: ulid(),
			booking_id: booking.id,
			provider: payment.provider,
			method: "online",
			kind: "charge",
			amount_minor: payment.amountMinor,
			currency: payment.currency,
			status: "captured",
			provider_ref: payment.providerRef,
		})
		.execute();
	const paid = payment.amountMinor >= booking.price_minor;
	await updateBooking(db, booking, { payment_status: paid ? "paid" : "unpaid", ...(booking.status === "pending_payment" && paid ? { status: "confirmed" } : {}) });
	await addEvent(db, booking.id, system, "payment", booking.status, paid && booking.status === "pending_payment" ? "confirmed" : null, {
		provider: payment.provider,
		amount_minor: payment.amountMinor,
		ref: payment.providerRef,
	});
	booking = (await db.selectFrom("sd_bookings").selectAll().where("id", "=", bookingId).executeTakeFirst()) as Booking;
	return booking;
}

/** The status a quote moves to when the customer accepts it. */
export const acceptedStatus = (booking: Booking): BookingStatus => (booking.payment_method === "online" ? "pending_payment" : "confirmed");

/** The customer accepts or declines a quote from their booking page. */
export async function answerQuote(db: Db, booking: Booking, accept: boolean) {
	if (booking.status !== "quoted") throw new Error("not_a_quote");
	const actor: Actor = { kind: "passenger" };
	if (accept) {
		if (Date.parse(booking.pickup_at) < Date.now()) throw new Error("expired");
		await transition(db, booking, acceptedStatus(booking), actor);
		await addEvent(db, booking.id, actor, "quote_accepted", "quoted", acceptedStatus(booking), { price_minor: booking.price_minor });
	} else {
		await transition(db, booking, "cancelled", actor, { reason: "Müşteri teklifi reddetti", refundPct: 0 });
		await addEvent(db, booking.id, actor, "quote_declined", "quoted", "cancelled", { price_minor: booking.price_minor });
	}
	const link = await db.selectFrom("sd_inquiry_bookings").select("inquiry_id").where("booking_code", "=", booking.code).executeTakeFirst();
	if (link) await db.updateTable("ec_inquiries").set({ status_label: accept ? "booked" : "closed" }).where("id", "=", link.inquiry_id).execute();
}
