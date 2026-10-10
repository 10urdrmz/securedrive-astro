/**
 * POST /api/odeme/iyzico — where iyzico's payment page returns the passenger.
 *
 * The browser posts only a token, from iyzico's own domain (so this path is exempt
 * from the same-origin form check in src/middleware.ts). We ask iyzico what the token
 * paid for; the booking is confirmed only from that server-to-server answer.
 */
import type { APIRoute } from "astro";
import { bookPath, isLocale } from "../../../i18n/locales";
import { NO_STORE } from "../../../lib/account-page";
import { getDb } from "../../../server/db";
import { confirmOnlinePayment, type Booking } from "../../../server/bookings";
import { checkoutResult } from "../../../server/payments/iyzico";

export const POST: APIRoute = async ({ request, locals }) => {
	const form = await request.formData().catch(() => null);
	const token = typeof form?.get("token") === "string" ? (form!.get("token") as string).slice(0, 200) : "";
	if (!token) return new Response("Bad request", { status: 400 });

	const db = await getDb(locals);
	const result = await checkoutResult(token).catch((error: unknown) => {
		console.error("iyzico result lookup failed", error);
		return null;
	});
	const booking = result?.bookingId
		? ((await db.selectFrom("sd_bookings").selectAll().where("id", "=", result.bookingId).executeTakeFirst()) as Booking | undefined)
		: undefined;
	if (!booking) return new Response("Payment not recognised. Please call us.", { status: 404, headers: { "Cache-Control": NO_STORE } });

	let ok = "paymentFailed";
	if (result!.paid && result!.paymentId && result!.currency === "TRY") {
		await confirmOnlinePayment(db, booking.id, { provider: "iyzico", providerRef: result!.paymentId, amountMinor: result!.paidMinor, currency: result!.currency });
		ok = "paid";
	} else {
		console.warn("iyzico payment not completed", booking.code, result!.error);
	}
	const locale = isLocale(booking.locale) ? booking.locale : "tr";
	return new Response(null, {
		status: 303,
		headers: { Location: `${bookPath(locale, booking.code, booking.tracking_token)}&ok=${ok}`, "Cache-Control": NO_STORE },
	});
};
