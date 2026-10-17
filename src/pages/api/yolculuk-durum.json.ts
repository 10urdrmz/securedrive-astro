import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { getBookingByCode, sameSecret } from "../../server/bookings";
import { flightView, getFlight } from "../../server/flights";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const GET: APIRoute = async ({ locals, url }) => {
	const code = (url.searchParams.get("code") ?? "").toUpperCase().slice(0, 20);
	const token = (url.searchParams.get("t") ?? "").slice(0, 64);

	if (!code || !token) return json({ error: "missing_params" }, 400);

	const db = await getDb(locals);
	const booking = await getBookingByCode(db, code);
	if (!booking || !sameSecret(token, booking.tracking_token)) {
		return json({ error: "not_found" }, 404);
	}

	const flight = booking.flight_no ? flightView(await getFlight(db, booking.id)) : null;

	let driverInfo = null;
	if (booking.driver_id) {
		const driver = await db
			.selectFrom("sd_drivers")
			.select(["name", "plate", "vehicle"])
			.where("id", "=", booking.driver_id)
			.executeTakeFirst();
		if (driver) driverInfo = driver;
	}

	return json({
		code: booking.code,
		status: booking.status,
		version: booking.version,
		driver: driverInfo,
		flight: flight
			? {
					status: flight.status,
					delayMin: flight.delayMin,
					at: flight.at,
				}
			: null,
	});
};
