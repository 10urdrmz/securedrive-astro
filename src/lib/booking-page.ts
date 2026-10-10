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
	ConflictError,
	createBooking,
	getBookingByCode,
	sameSecret,
	transition,
	type Booking,
	type PaymentMethod,
} from "../server/bookings";
import { quote, refundPct, type ClassQuote, type Quote, type QuoteInput } from "../server/pricing";
import { getSettings } from "../server/settings";
import { NO_STORE } from "./account-page";
import { allowVisitor, currentMember, EMAIL, PHONE, type Member } from "./members";

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
	step: 1 | 2 | 3;
	zones: Zone[];
	trip: Partial<Trip>;
	quote?: Quote;
	option?: ClassQuote;
	error?: UiKey;
	/** Details typed so far, to refill the form after an error. */
	values: Record<string, string>;
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
	driver: { name: string; phone: string; plate: string | null; vehicle: string | null } | null;
	/** Hours before pickup until which the passenger may cancel online, free of charge. */
	freeCancelHours: number;
	canCancel: boolean;
	notice?: "created" | "cancelled";
	error?: UiKey;
}

export type BookPage = WizardPage | BookingDetail;

const CODE = /^SD-\d{4}-\d{4,}$/i;
const PUBLIC_METHODS: PaymentMethod[] = ["cash", "card_in_vehicle"];

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const int = (value: string | null, fallback: number) => (value && /^\d{1,2}$/.test(value) ? Number(value) : fallback);

function noStore(Astro: AstroGlobal) {
	Astro.cache?.set(false);
	Astro.response.headers.set("Cache-Control", NO_STORE);
	// The booking link carries a secret; never leak it to other sites.
	Astro.response.headers.set("Referrer-Policy", "no-referrer");
}

function redirect(Astro: AstroGlobal, to: string) {
	const response = Astro.redirect(to, 303);
	response.headers.set("Cache-Control", NO_STORE);
	return response;
}

async function loadZones(db: Db): Promise<Zone[]> {
	return db.selectFrom("sd_zones").select(["id", "name", "kind"]).where("serviceable", "=", 1).orderBy("sort").execute();
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
	const page: WizardPage = { view: "wizard", locale, member, step: 1, zones, trip, values: {} };
	if (!trip.from || !trip.to || !trip.date || !trip.time) return page;

	const input: QuoteInput = { fromZoneId: trip.from, toZoneId: trip.to, date: trip.date, time: trip.time, pax: trip.pax!, bags: trip.bags! };
	const isPost = Astro.request.method === "POST";
	let form: FormData | null = null;
	if (isPost) {
		if (Astro.request.headers.get("origin") !== Astro.url.origin) return new Response("Forbidden", { status: 403 });
		form = await Astro.request.formData();
		input.extras = {};
		for (const [key, value] of form.entries()) {
			if (key.startsWith("extra_") && typeof value === "string") input.extras[key.slice(6)] = int(value, 0);
		}
	}

	const result = await quote(db, input);
	if (!result.ok) {
		Astro.response.status = 422;
		return { ...page, error: `book.error.${result.error}` as UiKey };
	}
	page.quote = result.quote;
	page.step = 2;
	const classKey = clean(params.get("class"), 40);
	const option = result.quote.options.find((o) => o.classKey === classKey && o.fits);
	if (!option) return page;
	page.option = option;
	page.step = 3;
	page.values = { name: member?.name ?? "", phone: member?.phone ?? "", email: member?.email ?? "", payment: "cash" };
	if (!form) return page;

	const field = (name: string, max = 200) => clean(form!.get(name), max);
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
	for (const [key, qty] of Object.entries(input.extras ?? {})) page.values[`extra_${key}`] = String(qty);
	const fail = (error: string, status = 422) => {
		Astro.response.status = status;
		return { ...page, error: `book.error.${error}` as UiKey };
	};
	// Honeypot: people never see or fill this field.
	if (field("website")) return redirect(Astro, bookPath(locale));
	const v = page.values;
	if (v.name.length < 2 || !PHONE.test(v.phone)) return fail("details");
	if (v.email && !EMAIL.test(v.email)) return fail("email");
	if (!PUBLIC_METHODS.includes(v.payment as PaymentMethod)) return fail("details");
	if (form.get("terms") !== "on") return fail("terms");
	if (!(await allowVisitor(Astro, "booking", 5, 60))) return fail("rate", 429);

	// The district side carries the hotel or home address; the airport side needs none.
	const addressOnPickup = result.quote.from.kind !== "airport";
	const booking = await createBooking(
		db,
		{
			quote: result.quote,
			option,
			contact: { name: v.name, phone: v.phone, email: v.email || null },
			flightNo: v.flight || null,
			signName: v.sign || v.name,
			pickupAddress: addressOnPickup ? v.address || null : null,
			dropoffAddress: addressOnPickup ? null : v.address || null,
			notes: v.notes || null,
			pax: input.pax,
			bags: input.bags,
			paymentMethod: v.payment as PaymentMethod,
			source: "web",
			locale,
			memberId: member?.id ?? null,
		},
		{ kind: "passenger" },
	);
	return redirect(Astro, `${bookPath(locale, booking.code, booking.tracking_token)}&ok=created`);
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
	const cancellable = ["pending_payment", "confirmed", "assigned"].includes(booking.status);
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
		freeCancelHours: Number.isFinite(freeCancelHours) ? freeCancelHours : 0,
		canCancel,
	};
	const ok = Astro.url.searchParams.get("ok");
	if (ok === "created" || ok === "cancelled") page.notice = ok;

	if (Astro.request.method === "POST") {
		if (Astro.request.headers.get("origin") !== Astro.url.origin) return new Response("Forbidden", { status: 403 });
		const form = await Astro.request.formData();
		if (form.get("intent") !== "cancel") return redirect(Astro, self);
		if (!canCancel) {
			Astro.response.status = 422;
			return { ...page, error: "book.error.cancelClosed" };
		}
		try {
			await transition(db, booking, "cancelled", { kind: "passenger" }, { reason: "Yolcu online iptal etti", refundPct: 100 });
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
