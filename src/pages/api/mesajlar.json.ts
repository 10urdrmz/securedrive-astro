/** The passenger's message thread: GET ?code=&t= with the booking's tracking token. Reading marks it read. */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { getBookingByCode, sameSecret } from "../../server/bookings";
import { canWrite, chatJson, listMessages, markRead } from "../../server/messages";

export const GET: APIRoute = async ({ locals, url }) => {
	const code = (url.searchParams.get("code") ?? "").toUpperCase().slice(0, 20);
	const token = (url.searchParams.get("t") ?? "").slice(0, 64);
	const db = await getDb(locals);
	const booking = code && token ? await getBookingByCode(db, code) : undefined;
	if (!booking || !sameSecret(token, booking.tracking_token))
		return new Response('{"error":"not_found"}', { status: 404, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
	const messages = await listMessages(db, booking, "passenger");
	await markRead(db, booking.id, "passenger");
	return chatJson(messages, canWrite(booking, "passenger"));
};
