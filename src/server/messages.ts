/**
 * In-app messages for a booking. Passenger, driver and ops write in one thread per
 * booking instead of calling or WhatsApp-ing each other, so the passenger and the
 * driver never see each other's phone number (KVKK). Phone numbers and e-mail
 * addresses typed by the passenger or the driver are masked before they are stored.
 *
 * The driver only sees the thread while the booking is theirs, and only from the
 * moment it was assigned to them.
 */
import type { Db } from "./db";
import { ulid } from "./ids";
import { FINAL_STATUSES, type Booking } from "./bookings";
import { notifyChat } from "./realtime";

export type ChatRole = "passenger" | "driver" | "ops";
export type Sender = ChatRole | "system";

export interface ChatMessage {
	id: string;
	sender: Sender;
	/** Shown above the message: first name for the passenger and the driver. */
	name: string;
	body: string;
	at: string;
}

export const MAX_MESSAGE = 1000;

const PHONE = /\+?\d[\d\s().\-/]{6,}\d/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const CONTACT_LINK = /\b(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|t\.me|telegram\.me)\/\S*/gi;

/** Masks contact details so the passenger and the driver cannot swap numbers. */
export function maskContacts(text: string): string {
	return text
		.replace(CONTACT_LINK, "[bağlantı gizlendi]")
		.replace(EMAIL, "[e-posta gizlendi]")
		.replace(PHONE, (match) => (match.replace(/\D/g, "").length >= 7 ? "[numara gizlendi]" : match));
}

export const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] ?? "";

/**
 * Whether this side may still write on the booking. Once the trip is completed, a no-show or
 * cancelled, the thread is closed for everyone: the history stays readable, nobody writes.
 */
export function canWrite(booking: Booking, role: ChatRole): boolean {
	if (FINAL_STATUSES.includes(booking.status)) return false;
	if (role === "ops") return true;
	if (booking.status === "quoted" || booking.status === "bidding") return false;
	return role === "passenger" || !!booking.driver_id;
}

/** When the current driver got the booking; they see nothing older. */
async function driverSince(db: Db, booking: Booking): Promise<string | null> {
	if (!booking.driver_id) return null;
	const row = await db
		.selectFrom("sd_assignments")
		.select("created_at")
		.where("booking_id", "=", booking.id)
		.where("driver_id", "=", booking.driver_id)
		.where("status", "in", ["accepted", "done"])
		.orderBy("created_at", "desc")
		.executeTakeFirst();
	return row?.created_at ?? null;
}

export async function listMessages(db: Db, booking: Booking, role: ChatRole): Promise<ChatMessage[]> {
	let query = db
		.selectFrom("sd_messages")
		.select(["id", "sender", "sender_name", "body", "at"])
		.where("booking_id", "=", booking.id)
		.orderBy("at")
		.limit(300);
	if (role === "driver") {
		const since = await driverSince(db, booking);
		if (!since) return [];
		query = query.where("at", ">=", since);
	}
	const rows = await query.execute();
	return rows.map((r) => ({ id: r.id, sender: r.sender as Sender, name: r.sender_name ?? "", body: r.body, at: r.at }));
}

export async function postMessage(db: Db, booking: Booking, sender: ChatRole, senderId: string | null, senderName: string, text: string): Promise<boolean> {
	const trimmed = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_MESSAGE);
	if (!trimmed || !canWrite(booking, sender)) return false;
	const body = sender === "ops" ? trimmed : maskContacts(trimmed);
	const at = new Date().toISOString();
	await db.insertInto("sd_messages").values({ id: ulid(), booking_id: booking.id, sender, sender_id: senderId, sender_name: senderName, body, at }).execute();
	await markRead(db, booking.id, sender, at);
	await notifyChat(booking);
	return true;
}

export async function markRead(db: Db, bookingId: string, reader: ChatRole, at = new Date().toISOString()) {
	await db
		.insertInto("sd_message_reads")
		.values({ booking_id: bookingId, reader, last_read_at: at })
		.onConflict((oc) => oc.columns(["booking_id", "reader"]).doUpdateSet({ last_read_at: at }))
		.execute();
}

/** Unread messages per booking for one side (messages the others wrote after it last read). */
export async function unreadCounts(db: Db, bookingIds: string[], reader: ChatRole): Promise<Map<string, number>> {
	if (bookingIds.length === 0) return new Map();
	let query = db
		.selectFrom("sd_messages as m")
		.leftJoin("sd_message_reads as r", (join) => join.onRef("r.booking_id", "=", "m.booking_id").on("r.reader", "=", reader))
		.select(["m.booking_id", (eb) => eb.fn.countAll<number>().as("n")])
		.where("m.booking_id", "in", bookingIds)
		.where("m.sender", "not in", [reader, "system"])
		.where((eb) => eb.or([eb("r.last_read_at", "is", null), eb("m.at", ">", eb.ref("r.last_read_at"))]));
	// The driver only counts what was written since the job became theirs.
	if (reader === "driver")
		query = query.where((eb) =>
			eb.exists(
				eb
					.selectFrom("sd_assignments as a")
					.innerJoin("sd_bookings as b", (join) => join.onRef("b.id", "=", "a.booking_id").onRef("b.driver_id", "=", "a.driver_id"))
					.select("a.id")
					.whereRef("a.booking_id", "=", "m.booking_id")
					.where("a.status", "in", ["accepted", "done"])
					.whereRef("a.created_at", "<=", "m.at"),
			),
		);
	const rows = await query.groupBy("m.booking_id").execute();
	return new Map(rows.map((r) => [r.booking_id as string, Number(r.n)]));
}

/** Latest messages from passengers and drivers that ops has not read, for the bell. */
export async function opsUnread(db: Db, limit = 12) {
	return db
		.selectFrom("sd_messages as m")
		.innerJoin("sd_bookings as b", "b.id", "m.booking_id")
		.leftJoin("sd_message_reads as r", (join) => join.onRef("r.booking_id", "=", "m.booking_id").on("r.reader", "=", "ops"))
		.select(["m.id", "m.sender", "m.sender_name", "m.body", "m.at", "b.code"])
		.where("m.sender", "in", ["passenger", "driver"])
		.where((eb) => eb.or([eb("r.last_read_at", "is", null), eb("m.at", ">", eb.ref("r.last_read_at"))]))
		.orderBy("m.at", "desc")
		.limit(limit)
		.execute();
}

/** The JSON the chat box polls. */
export const chatJson = (messages: ChatMessage[], writable: boolean) =>
	new Response(JSON.stringify({ messages, writable }), {
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
	});
