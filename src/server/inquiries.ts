/**
 * Transfer quote requests (EmDash "inquiries" collection, written by plugins/inquiries)
 * as ops sees them, and turning one into a booking.
 *
 * The collection holds personal data: only /ops pages may call this.
 */
import type { Db } from "./db";
import { isoToIstanbul } from "./pricing";

export interface OpsInquiry {
	id: string;
	reference: string;
	status: string;
	createdAt: string;
	name: string;
	phone: string;
	email: string;
	message: string;
	locale: string;
	from: string;
	to: string;
	date: string;
	time: string;
	passengers: number | null;
	luggage: number | null;
	flight: string;
	vehicle: string;
	returnTrip: boolean;
	/** Site member who sent it while signed in, if any. */
	memberId: string | null;
	/** Booking made from it, if any. */
	bookingCode: string | null;
}

export const INQUIRY_STATUS_LABELS: Record<string, string> = {
	new: "Yeni",
	contacted: "İletişime geçildi",
	quoted: "Teklif gönderildi",
	booked: "Rezervasyon yapıldı",
	closed: "Kapandı",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toInquiry(row: any): OpsInquiry {
	let d: Record<string, unknown> = {};
	try {
		d = (typeof row.details === "string" ? JSON.parse(row.details) : row.details) ?? {};
	} catch {
		// Keep the contact details even when the trip part is unreadable.
	}
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const num = (v: unknown) => (typeof v === "number" ? v : null);
	return {
		id: row.id,
		reference: row.reference || `SD-${String(row.id).slice(-8)}`,
		status: row.status_label || "new",
		createdAt: row.created_at,
		name: str(row.name),
		phone: str(row.phone),
		email: str(row.email),
		message: str(row.message),
		locale: str(row.form_locale) || "tr",
		from: str(d.from),
		to: str(d.to),
		date: str(d.date),
		time: str(d.time),
		passengers: num(d.passengers),
		luggage: num(d.luggage),
		flight: str(d.flight),
		vehicle: str(d.vehicle),
		returnTrip: d.return_trip === true,
		memberId: row.member_id ?? null,
		bookingCode: row.booking_code ?? null,
	};
}

function baseQuery(db: Db) {
	return db
		.selectFrom("ec_inquiries as i")
		.leftJoin("sd_member_requests as m", "m.inquiry_id", "i.id")
		.leftJoin("sd_inquiry_bookings as b", "b.inquiry_id", "i.id")
		.select([
			"i.id",
			"i.reference",
			"i.status_label",
			"i.created_at",
			"i.name",
			"i.phone",
			"i.email",
			"i.message",
			"i.form_locale",
			"i.details",
			"m.member_id as member_id",
			"b.booking_code as booking_code",
		])
		.where("i.kind", "=", "transfer")
		.where("i.deleted_at", "is", null);
}

/** Transfer requests, newest first; `open` hides booked and closed ones. */
export async function listTransferInquiries(db: Db, open: boolean): Promise<OpsInquiry[]> {
	let query = baseQuery(db);
	if (open) query = query.where((eb) => eb.or([eb("i.status_label", "is", null), eb("i.status_label", "in", ["new", "contacted", "quoted"])]));
	return (await query.orderBy("i.created_at", "desc").limit(300).execute()).map(toInquiry);
}

export async function getTransferInquiry(db: Db, id: string): Promise<OpsInquiry | null> {
	const row = await baseQuery(db).where("i.id", "=", id).executeTakeFirst();
	return row ? toInquiry(row) : null;
}

/** Values for the phone-booking form, from a request. Zones are matched by their name. */
export function bookingPrefill(inquiry: OpsInquiry, zones: { id: string; name: string }[]): Record<string, string> {
	const zone = (name: string) => zones.find((z) => z.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"))?.id ?? "";
	const fallback = isoToIstanbul(new Date(Date.now() + 24 * 3600_000).toISOString());
	return {
		from: zone(inquiry.from),
		to: zone(inquiry.to),
		date: inquiry.date || fallback.date,
		time: inquiry.time || "12:00",
		pax: String(inquiry.passengers ?? 2),
		bags: String(inquiry.luggage ?? inquiry.passengers ?? 2),
		name: inquiry.name,
		phone: inquiry.phone,
		email: inquiry.email,
		flight: inquiry.flight,
		notes: inquiry.message,
		internal: `Talep ${inquiry.reference}${inquiry.vehicle ? ` · istenen araç: ${inquiry.vehicle}` : ""}${inquiry.returnTrip ? " · dönüş de istendi (ayrı rezervasyon)" : ""}`,
	};
}

/**
 * Link the request to its booking. A booking moves it to "booked"; a quote sent to the
 * customer moves it to "quoted" until they answer (see answerQuote).
 */
export async function markInquiryBooked(db: Db, inquiryId: string, bookingCode: string, status: "booked" | "quoted" = "booked") {
	await db
		.insertInto("sd_inquiry_bookings")
		.values({ inquiry_id: inquiryId, booking_code: bookingCode, created_at: new Date().toISOString() })
		.onConflict((oc) => oc.column("inquiry_id").doUpdateSet({ booking_code: bookingCode }))
		.execute();
	await db.updateTable("ec_inquiries").set({ status_label: status }).where("id", "=", inquiryId).execute();
}
