import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { driverJob, jobBadge, sessionDriver } from "../../server/driver-app";
import { flightView, getFlight } from "../../server/flights";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const GET: APIRoute = async ({ locals, cookies, url }) => {
	const db = await getDb(locals);
	const driver = await sessionDriver(db, cookies);
	if (!driver) return json({ error: "auth" }, 401);

	const code = (url.searchParams.get("code") ?? "").toUpperCase().slice(0, 20);
	if (!code) return json({ error: "missing_code" }, 400);

	const job = await driverJob(db, driver.id, code);
	if (!job) return json({ error: "not_found" }, 404);

	const b = job.booking;
	const flight = b.flight_no ? flightView(await getFlight(db, b.id)) : null;
	const badge = jobBadge(job);

	return json({
		code: b.code,
		status: b.status,
		version: b.version,
		badge: { label: badge.label, tone: badge.tone },
		flight: flight
			? {
					status: flight.status,
					delayMin: flight.delayMin,
					at: flight.at,
					terminal: flight.terminal,
					belt: flight.belt,
				}
			: null,
		paymentStatus: b.payment_status,
	});
};
