/**
 * Where the passenger's car is: GET ?code=&t= with the booking's tracking token.
 * Answers only while the trip is live; the driver's position is never shown otherwise.
 */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { getBookingByCode, sameSecret } from "../../server/bookings";
import { bookingPosition } from "../../server/live-location";

export const GET: APIRoute = async ({ locals, url }) => {
	const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
	const code = (url.searchParams.get("code") ?? "").toUpperCase().slice(0, 20);
	const token = (url.searchParams.get("t") ?? "").slice(0, 64);
	const db = await getDb(locals);
	const booking = code && token ? await getBookingByCode(db, code) : undefined;
	if (!booking || !sameSecret(token, booking.tracking_token)) return new Response('{"error":"not_found"}', { status: 404, headers });
	return new Response(JSON.stringify({ position: await bookingPosition(db, booking), status: booking.status }), { headers });
};
