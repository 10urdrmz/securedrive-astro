/** A booking's whole message thread for ops: GET ?code=. Reading marks it read for ops. */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { getSessionUser } from "../../server/auth/session";
import { can } from "../../server/auth/rbac";
import { getBookingByCode } from "../../server/bookings";
import { chatJson, listMessages, markRead } from "../../server/messages";

export const GET: APIRoute = async ({ locals, cookies, url }) => {
	const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
	const db = await getDb(locals);
	const user = await getSessionUser(db, cookies, "ops");
	if (!user || !can(user, "bookings.read")) return new Response('{"error":"auth"}', { status: 401, headers });
	const booking = await getBookingByCode(db, (url.searchParams.get("code") ?? "").toUpperCase().slice(0, 20));
	if (!booking) return new Response('{"error":"not_found"}', { status: 404, headers });
	const messages = await listMessages(db, booking, "ops");
	await markRead(db, booking.id, "ops");
	return chatJson(messages, can(user, "bookings.write"));
};
