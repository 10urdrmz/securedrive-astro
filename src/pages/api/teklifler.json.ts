import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { getBookingByCode, sameSecret } from "../../server/bookings";
import { offersFor } from "../../server/offers";
import { formatMoney } from "../../server/ops";

export const GET: APIRoute = async ({ locals, url }) => {
	const code = (url.searchParams.get("code") ?? "").toUpperCase().slice(0, 20);
	const token = (url.searchParams.get("t") ?? "").slice(0, 64);
	const headers = {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"X-Robots-Tag": "noindex",
	};

	if (!code || !token) {
		return new Response(JSON.stringify({ error: "missing_params" }), { status: 400, headers });
	}

	const db = await getDb(locals);
	const booking = await getBookingByCode(db, code);
	if (!booking || !sameSecret(token, booking.tracking_token)) {
		return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers });
	}

	if (booking.status !== "bidding") {
		return new Response(
			JSON.stringify({
				status: booking.status,
				offersCount: 0,
				offers: [],
			}),
			{ status: 200, headers },
		);
	}

	const offers = await offersFor(db, booking);
	const formattedOffers = offers.map((o) => ({
		id: o.id,
		displayName: o.display_name,
		className: o.class_name,
		vehicle: o.vehicle,
		priceMinor: o.price_minor,
		formattedPrice: `${formatMoney(o.price_minor)} ₺`,
		paxMax: o.pax_max,
		bagsMax: o.bags_max,
		rating: o.rating,
		ratings: o.ratings,
		trips: o.trips,
		note: o.note,
	}));

	return new Response(
		JSON.stringify({
			status: booking.status,
			offersCount: formattedOffers.length,
			offers: formattedOffers,
		}),
		{ status: 200, headers },
	);
};
