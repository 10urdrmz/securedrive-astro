/**
 * GET /api/odeme/baslat?code=…&t=… — start (or retry) the online payment of a booking
 * and send the passenger to iyzico's hosted payment page.
 */
import type { APIRoute } from "astro";
import { bookPath, isLocale } from "../../../i18n/locales";
import { NO_STORE } from "../../../lib/account-page";
import { getDb } from "../../../server/db";
import { getBookingByCode, sameSecret } from "../../../server/bookings";
import { startCheckout } from "../../../server/payments/iyzico";

export const GET: APIRoute = async (context) => {
	const { url, locals } = context;
	const code = (url.searchParams.get("code") ?? "").slice(0, 24);
	const token = (url.searchParams.get("t") ?? "").slice(0, 64);
	const db = await getDb(locals);
	const booking = code ? await getBookingByCode(db, code) : undefined;
	if (!booking || !token || !sameSecret(token, booking.tracking_token)) return new Response("Not found", { status: 404 });

	const locale = isLocale(booking.locale) ? booking.locale : "tr";
	const back = (ok: string) =>
		new Response(null, { status: 303, headers: { Location: `${bookPath(locale, booking.code, booking.tracking_token)}&ok=${ok}`, "Cache-Control": NO_STORE } });
	// Paid already, cancelled, or not an online booking: nothing to pay.
	if (booking.status !== "pending_payment" || booking.payment_method !== "online") return back("created");

	let ip = "127.0.0.1";
	try {
		ip = context.clientAddress;
	} catch {
		// Not every adapter knows the address; iyzico only uses it for fraud scoring.
	}
	const zones = await db.selectFrom("sd_zones").select(["id", "name"]).where("id", "in", [booking.from_zone_id, booking.to_zone_id]).execute();
	const name = (id: string) => zones.find((z) => z.id === id)?.name ?? id;
	const result = await startCheckout({
		bookingId: booking.id,
		code: booking.code,
		priceMinor: booking.price_minor,
		locale,
		callbackUrl: new URL("/api/odeme/iyzico", url.origin).href,
		description: `VIP transfer ${booking.code}: ${name(booking.from_zone_id)} - ${name(booking.to_zone_id)}`,
		buyer: {
			id: booking.customer_member_id ?? booking.id,
			name: booking.contact_name,
			email: booking.contact_email ?? "",
			phone: booking.contact_phone,
			ip,
			address: booking.pickup_address || booking.dropoff_address || "Istanbul",
		},
	}).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
	if (!result.ok) {
		console.error("iyzico checkout failed", booking.code, result.error);
		return back("paymentFailed");
	}
	return new Response(null, { status: 303, headers: { Location: result.url, "Cache-Control": NO_STORE } });
};
