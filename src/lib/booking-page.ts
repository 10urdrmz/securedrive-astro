/**
 * Request handling for online booking (/rezervasyon and /rezervasyon/<code>).
 *
 * The wizard needs no JavaScript: each step is a GET with the trip in the query string
 * (route + time → vehicle → details), and only the last step POSTs. The price is
 * recomputed on the server at submit; nothing the browser sends is trusted for money.
 *
 * A booking page opens for the member who made it, or for anyone holding its secret
 * link (?t=…), which the confirmation page and later e-mails carry.
 */
import type { AstroGlobal } from "astro";
import { bookPath, type Locale } from "../i18n/locales";
import type { UiKey } from "../i18n/ui";
import { getDb, type Db } from "../server/db";
import {
	addEvent,
	answerQuote,
	ConflictError,
	getBookingByCode,
	sameSecret,
	transition,
	type Booking,
	type PaymentMethod,
} from "../server/bookings";
import { istanbulToIso, refundPct } from "../server/pricing";
import { createRequest, offersFor, pickOffer, type OfferCard } from "../server/offers";
import { getSettings } from "../server/settings";
import { NO_STORE } from "./account-page";
import { allowVisitor, currentMember, EMAIL, PHONE, type Member } from "./members";
import { canWrite, firstName, listMessages, markRead, postMessage, type ChatMessage } from "../server/messages";
import { iyzicoEnabled, iyzicoIsSandbox } from "../server/payments/iyzico";
import { flightView, getFlight, type FlightView } from "../server/flights";
import { referringAgency } from "../server/agencies";

export interface Zone {
	id: string;
	name: string;
	kind: string;
}

export interface Trip {
	from: string;
	to: string;
	date: string;
	time: string;
	pax: number;
	bags: number;
}

export interface WizardPage {
	view: "wizard";
	locale: Locale;
	member: Member | null;
	step: 1 | 2;
	zones: Zone[];
	trip: Partial<Trip>;
	/** Extras the customer may ask for in step 2 (child seat …), with their price. */
	extras?: { key: string; name: string; price_minor: number; max_qty: number }[];
	/** The address field is the pickup (district → airport) rather than the drop-off. */
	addressOnPickup?: boolean;
	error?: UiKey;
	/** Details typed so far, to refill the form after an error. */
	values: Record<string, string>;
	/** Online card payment is configured (iyzico keys present). */
	online: boolean;
	/** Online payment runs against the iyzico sandbox (test cards only). */
	sandbox: boolean;
}

export interface BookingDetail {
	view: "detail";
	locale: Locale;
	member: Member | null;
	booking: Booking;
	token: string;
	fromName: string;
	toName: string;
	className: string;
	lines: { kind: string; label: string; qty?: number; amount_minor: number }[];
	/** The passenger never gets the driver's phone: they write through the messages. */
	driver: { name: string; plate: string | null; vehicle: string | null } | null;
	messages: ChatMessage[];
	chatWritable: boolean;
	/** The arriving flight's status, for airport pickups once it is tracked. */
	flight: FlightView | null;
	/** Hours before pickup until which the passenger may cancel online, free of charge. */
	freeCancelHours: number;
	canCancel: boolean;
	notice?: "created" | "cancelled" | "paid" | "paymentFailed" | "reviewed" | "quoteAccepted" | "quoteDeclined" | "requested" | "picked";
	/** While the request waits for carriers: their live offers, cheapest first. */
	offers: OfferCard[];
	/** Extras asked for on a request, added to the offer the customer picks. */
	requestedExtras: { name: string; qty: number; price_minor: number }[];
	/** Where "pay now" leads, while a booking waits for its online payment. */
	payHref: string | null;
	/** The passenger's review, once given; reviews open when the trip is completed. */
	review: { rating: number; comment: string | null } | null;
	canReview: boolean;
	/** Render the printable receipt instead of the page. */
	receipt: boolean;
	error?: UiKey;
}

export type BookPage = WizardPage | BookingDetail;

const CODE = /^SD-\d{4}-\d{4,}$/i;
/** A request is paid in the vehicle; online payment would need the price before the offers. */
const REQUEST_METHODS: PaymentMethod[] = ["cash", "card_in_vehicle"];

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const int = (value: string | null, fallback: number) => (value && /^\d{1,2}$/.test(value) ? Number(value) : fallback);

function noStore(Astro: AstroGlobal) {
	Astro.cache?.set(false);
	Astro.response.headers.set("Cache-Control", NO_STORE);
	// The booking link carries a secret; never leak it to other sites. ("no-referrer" would
	// also make browsers send "Origin: null" on our own form posts, which we then refuse.)
	Astro.response.headers.set("Referrer-Policy", "same-origin");
}

function redirect(Astro: AstroGlobal, to: string) {
	const response = Astro.redirect(to, 303);
	response.headers.set("Cache-Control", NO_STORE);
	return response;
}

async function loadZones(db: Db): Promise<Zone[]> {
	return db.selectFrom("sd_zones").select(["id", "name", "kind"]).where("serviceable", "=", 1).orderBy("sort").execute();
}

/** The trip itself can be served: real places, not the same one, far enough ahead. */
async function checkTrip(db: Db, trip: Trip): Promise<string | null> {
	const pickupAt = istanbulToIso(trip.date, trip.time);
	if (!pickupAt || trip.from === trip.to) return "invalidInput";
	const hours = (Date.parse(pickupAt) - Date.now()) / 3600_000;
	if (hours < 0) return "past";
	if (hours < (await getSettings(db)).minLeadHours) return "tooSoon";
	const zones = await db.selectFrom("sd_zones").select("serviceable").where("id", "in", [trip.from, trip.to]).execute();
	if (zones.length !== 2) return "invalidInput";
	if (zones.some((z) => !z.serviceable)) return "notServiceable";
	const fits = await db.selectFrom("sd_vehicle_classes").select("key").where("active", "=", 1).where("pax_max", ">=", trip.pax).where("bags_max", ">=", trip.bags).executeTakeFirst();
	return fits ? null : "tooMany";
}

function readTrip(params: URLSearchParams): Partial<Trip> {
	return {
		from: clean(params.get("from"), 40) || undefined,
		to: clean(params.get("to"), 40) || undefined,
		date: clean(params.get("date"), 10) || undefined,
		time: clean(params.get("time"), 5) || undefined,
		pax: int(params.get("pax"), 2),
		bags: int(params.get("bags"), 2),
	};
}

export async function runBookPage(Astro: AstroGlobal, locale: Locale, rest: string): Promise<Response | BookPage | null> {
	noStore(Astro);
	if (rest && !CODE.test(rest)) return null;
	const db = await getDb(Astro.locals);
	const member = await currentMember(Astro);
	return rest ? bookingDetail(Astro, db, locale, member, rest) : wizard(Astro, db, locale, member);
}

async function wizard(Astro: AstroGlobal, db: Db, locale: Locale, member: Member | null): Promise<Response | WizardPage> {
	const zones = await loadZones(db);
	const params = Astro.url.searchParams;
	const trip = readTrip(params);
	const online = iyzicoEnabled();
	const page: WizardPage = { view: "wizard", locale, member, step: 1, zones, trip, values: {}, online, sandbox: online && iyzicoIsSandbox() };
	if (!trip.from || !trip.to || !trip.date || !trip.time) return page;
	const tripError = await checkTrip(db, trip as Trip);
	if (tripError) {
		Astro.response.status = 422;
		return { ...page, error: `book.error.${tripError}` as UiKey };
	}

	// Step 2: who travels, what they need, how they pay. Posting it opens the request
	// to carriers; prices come as offers on the booking page (offers.ts).
	page.step = 2;
	page.extras = await db.selectFrom("sd_extras").select(["key", "name", "price_minor", "max_qty"]).where("active", "=", 1).orderBy("sort").execute();
	const fromZone = zones.find((z) => z.id === trip.from);
	page.addressOnPickup = !!fromZone && fromZone.kind !== "airport";
	page.values = { name: member?.name ?? "", phone: member?.phone ?? "", email: member?.email ?? "", payment: "cash" };
	if (Astro.request.method !== "POST") return page;
	if (Astro.request.headers.get("origin") !== Astro.url.origin) return new Response("Forbidden", { status: 403 });
	const form = await Astro.request.formData();
	const extras: Record<string, number> = {};
	for (const [key, value] of form.entries()) {
		if (key.startsWith("extra_") && typeof value === "string") extras[key.slice(6)] = int(value, 0);
	}

	const field = (name: string, max = 200) => clean(form.get(name), max);
	page.values = {
		name: field("name", 80),
		phone: field("phone", 24),
		email: field("email", 120).toLowerCase(),
		flight: field("flight", 12).toUpperCase(),
		sign: field("sign", 60),
		address: field("address", 200),
		notes: field("notes", 1000),
		payment: field("payment", 20),
	};
	for (const [key, qty] of Object.entries(extras)) page.values[`extra_${key}`] = String(qty);
	const fail = (error: string, status = 422) => {
		Astro.response.status = status;
		return { ...page, error: `book.error.${error}` as UiKey };
	};
	// Honeypot: people never see or fill this field.
	if (field("website")) return redirect(Astro, bookPath(locale));
	const v = page.values;
	if (v.name.length < 2 || !PHONE.test(v.phone)) return fail("details");
	if (v.email && !EMAIL.test(v.email)) return fail("email");
	if (!REQUEST_METHODS.includes(v.payment as PaymentMethod)) return fail("details");
	if (form.get("terms") !== "on") return fail("terms");
	if (!(await allowVisitor(Astro, "booking", 5, 60))) return fail("rate", 429);

	const agency = await referringAgency(db, Astro.cookies);
	const result = await createRequest(db, {
		fromZoneId: trip.from,
		toZoneId: trip.to,
		date: trip.date,
		time: trip.time,
		pax: trip.pax!,
		bags: trip.bags!,
		contact: { name: v.name, phone: v.phone, email: v.email || null },
		flightNo: v.flight || null,
		signName: v.sign || v.name,
		pickupAddress: page.addressOnPickup ? v.address || null : null,
		dropoffAddress: page.addressOnPickup ? null : v.address || null,
		notes: v.notes || null,
		paymentMethod: v.payment as PaymentMethod,
		locale,
		memberId: member?.id ?? null,
		agencyId: agency?.id ?? null,
		extras,
	});
	if (!result.ok) return fail(result.error);
	return redirect(Astro, `${bookPath(locale, result.booking.code, result.booking.tracking_token)}&ok=requested`);
}

async function bookingDetail(
	Astro: AstroGlobal,
	db: Db,
	locale: Locale,
	member: Member | null,
	code: string,
): Promise<Response | BookingDetail | null> {
	const booking = await getBookingByCode(db, code);
	const token = clean(Astro.url.searchParams.get("t"), 64);
	if (!booking) return null;
	const isOwner = !!member && booking.customer_member_id === member.id;
	if (!isOwner && !(token && sameSecret(token, booking.tracking_token))) return null;

	const settings = await getSettings(db);
	const freeCancelHours = Math.min(...settings.cancellation.filter((r) => r.refundPct >= 100).map((r) => r.hoursBefore), Infinity);
	const cancellable = ["pending_payment", "confirmed", "assigned", "bidding"].includes(booking.status);
	const canCancel = cancellable && Number.isFinite(freeCancelHours) && refundPct(settings, booking.pickup_at) >= 100;
	const self = bookPath(locale, booking.code, booking.tracking_token);

	const detail = await describe(db, booking);
	const page: BookingDetail = {
		view: "detail",
		locale,
		member,
		booking,
		token: booking.tracking_token,
		...detail,
		driver: detail.driver ? { name: detail.driver.name, plate: detail.driver.plate, vehicle: detail.driver.vehicle } : null,
		messages: await listMessages(db, booking, "passenger"),
		chatWritable: canWrite(booking, "passenger"),
		flight: booking.flight_no ? flightView(await getFlight(db, booking.id)) : null,
		freeCancelHours: Number.isFinite(freeCancelHours) ? freeCancelHours : 0,
		canCancel,
		payHref: booking.status === "pending_payment" && booking.payment_method === "online" && iyzicoEnabled() ? paymentStartPath(booking) : null,
		review: null,
		canReview: false,
		receipt: Astro.url.searchParams.get("makbuz") === "1" && !["cancelled", "bidding"].includes(booking.status),
		offers: booking.status === "bidding" ? await offersFor(db, booking) : [],
		requestedExtras:
			booking.status === "bidding" ? await db.selectFrom("sd_booking_extras").select(["name", "qty", "price_minor"]).where("booking_id", "=", booking.id).execute() : [],
	};
	// A request is free to withdraw until an offer is picked.
	if (booking.status === "bidding") page.canCancel = true;
	page.review = (await db.selectFrom("sd_reviews").select(["rating", "comment"]).where("booking_id", "=", booking.id).executeTakeFirst()) ?? null;
	page.canReview = booking.status === "completed" && !page.review;
	if (Astro.request.method === "GET") await markRead(db, booking.id, "passenger");
	const ok = Astro.url.searchParams.get("ok");
	if (
		ok === "created" ||
		ok === "cancelled" ||
		ok === "paid" ||
		ok === "paymentFailed" ||
		ok === "reviewed" ||
		ok === "quoteAccepted" ||
		ok === "quoteDeclined" ||
		ok === "requested" ||
		ok === "picked"
	)
		page.notice = ok;

	if (Astro.request.method === "POST") {
		if (Astro.request.headers.get("origin") !== Astro.url.origin) return new Response("Forbidden", { status: 403 });
		const form = await Astro.request.formData();
		if (form.get("intent") === "message") {
			await postMessage(db, booking, "passenger", null, firstName(booking.contact_name), String(form.get("message") ?? ""));
			return redirect(Astro, `${self}#mesajlar`);
		}
		if (form.get("intent") === "review") {
			const rating = Number(form.get("rating"));
			if (!page.canReview || !Number.isInteger(rating) || rating < 1 || rating > 5) return redirect(Astro, self);
			await db
				.insertInto("sd_reviews")
				.values({ booking_id: booking.id, rating, comment: clean(form.get("comment"), 1000) || null, driver_id: booking.driver_id })
				.onConflict((oc) => oc.column("booking_id").doNothing())
				.execute();
			await addEvent(db, booking.id, { kind: "passenger" }, "review", null, null, { rating });
			return redirect(Astro, `${self}&ok=reviewed`);
		}
		if (form.get("intent") === "quote_accept" || form.get("intent") === "quote_decline") {
			const accept = form.get("intent") === "quote_accept";
			if (booking.status !== "quoted") return redirect(Astro, self);
			try {
				await answerQuote(db, booking, accept);
			} catch (error) {
				if (error instanceof Error && error.message === "expired") {
					Astro.response.status = 422;
					return { ...page, error: "book.error.quoteExpired" };
				}
				if (!(error instanceof ConflictError)) throw error;
			}
			return redirect(Astro, `${self}&ok=${accept ? "quoteAccepted" : "quoteDeclined"}`);
		}
		if (form.get("intent") === "pick") {
			if (booking.status !== "bidding") return redirect(Astro, self);
			try {
				await pickOffer(db, booking, clean(form.get("offer"), 40), { kind: "passenger" });
			} catch (error) {
				if (error instanceof ConflictError || (error instanceof Error && (error.message === "gone" || error.message === "closed"))) {
					Astro.response.status = 409;
					return { ...page, offers: await offersFor(db, (await getBookingByCode(db, booking.code))!), error: "book.error.offerGone" };
				}
				throw error;
			}
			return redirect(Astro, `${self}&ok=picked`);
		}
		if (form.get("intent") !== "cancel") return redirect(Astro, self);
		if (!canCancel) {
			Astro.response.status = 422;
			return { ...page, error: "book.error.cancelClosed" };
		}
		try {
			await transition(db, booking, "cancelled", { kind: "passenger" }, { reason: booking.status === "bidding" ? "Yolcu talebi geri çekti" : "Yolcu online iptal etti", refundPct: 100 });
			if (booking.status === "bidding") {
				await db.updateTable("sd_offers").set({ status: "lost", updated_at: new Date().toISOString() }).where("booking_id", "=", booking.id).where("status", "=", "active").execute();
			}
		} catch (error) {
			if (!(error instanceof ConflictError)) throw error;
		}
		return redirect(Astro, `${self}&ok=cancelled`);
	}
	return page;
}

/** Names and the driver for a booking, shared by the passenger page and ops. */
export async function describe(db: Db, booking: Booking) {
	const zones = await db.selectFrom("sd_zones").select(["id", "name"]).where("id", "in", [booking.from_zone_id, booking.to_zone_id]).execute();
	const vehicleClass = await db.selectFrom("sd_vehicle_classes").select("name").where("key", "=", booking.class_key).executeTakeFirst();
	const driver = booking.driver_id
		? await db.selectFrom("sd_drivers").select(["name", "phone", "plate", "vehicle"]).where("id", "=", booking.driver_id).executeTakeFirst()
		: null;
	let lines: BookingDetail["lines"] = [];
	try {
		lines = JSON.parse(booking.breakdown);
	} catch {
		// An unreadable breakdown still leaves the total.
	}
	return {
		fromName: zones.find((z) => z.id === booking.from_zone_id)?.name ?? booking.from_zone_id,
		toName: zones.find((z) => z.id === booking.to_zone_id)?.name ?? booking.to_zone_id,
		className: vehicleClass?.name ?? booking.class_key,
		lines,
		driver: driver ?? null,
	};
}

export interface BookingCard {
	code: string;
	token: string;
	status: string;
	pickupAt: string;
	fromName: string;
	toName: string;
	price_minor: number;
}

/** The member's own bookings for the account page; only trip facts, no contact details. */
export async function memberBookingCards(Astro: AstroGlobal, member: Member): Promise<BookingCard[]> {
	const db = await getDb(Astro.locals);
	const rows = await db
		.selectFrom("sd_bookings as b")
		.innerJoin("sd_zones as f", "f.id", "b.from_zone_id")
		.innerJoin("sd_zones as t", "t.id", "b.to_zone_id")
		.select(["b.code", "b.tracking_token", "b.status", "b.pickup_at", "b.price_minor", "f.name as from_name", "t.name as to_name"])
		.where("b.customer_member_id", "=", member.id)
		.orderBy("b.pickup_at", "desc")
		.limit(50)
		.execute();
	return rows.map((r) => ({
		code: r.code,
		token: r.tracking_token,
		status: r.status,
		pickupAt: r.pickup_at,
		fromName: r.from_name,
		toName: r.to_name,
		price_minor: r.price_minor,
	}));
}

/** Starts (or restarts) the online payment of a booking; see src/pages/api/odeme. */
export function paymentStartPath(booking: Pick<Booking, "code" | "tracking_token">): string {
	return `/api/odeme/baslat?${new URLSearchParams({ code: booking.code, t: booking.tracking_token })}`;
}
