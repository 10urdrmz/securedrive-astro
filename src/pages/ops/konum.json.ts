/** Live car positions for ops: every live trip, or one booking with ?code=. */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { getSessionUser } from "../../server/auth/session";
import { can } from "../../server/auth/rbac";
import { getBookingByCode } from "../../server/bookings";
import { bookingPosition, liveCars } from "../../server/live-location";

export const GET: APIRoute = async ({ locals, cookies, url }) => {
	const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
	const db = await getDb(locals);
	const user = await getSessionUser(db, cookies, "ops");
	if (!user || !can(user, "bookings.read")) return new Response('{"error":"auth"}', { status: 401, headers });
	const code = (url.searchParams.get("code") ?? "").toUpperCase().slice(0, 20);
	if (!code) return new Response(JSON.stringify({ cars: await liveCars(db) }), { headers });
	const booking = await getBookingByCode(db, code);
	const position = booking ? await bookingPosition(db, booking) : null;
	return new Response(JSON.stringify({ position, status: booking?.status ?? null }), { headers });
};
