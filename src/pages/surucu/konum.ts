/** The driver app's position reports: POST {code, lat, lng, accuracy?, heading?, speed?} while a trip is live. */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { driverJob, sessionDriver } from "../../server/driver-app";
import { isTracked, readPosition, savePosition } from "../../server/live-location";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const POST: APIRoute = async ({ locals, cookies, request }) => {
	const db = await getDb(locals);
	const driver = await sessionDriver(db, cookies);
	if (!driver) return json({ error: "auth" }, 401);
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: "body" }, 400);
	}
	const code = typeof body.code === "string" ? body.code.toUpperCase().slice(0, 20) : "";
	const job = code ? await driverJob(db, driver.id, code) : null;
	if (!job) return json({ error: "job" }, 404);
	// Trip over (or not started): the phone stops sending.
	if (!isTracked(job.booking.status)) return json({ track: false });
	const position = readPosition(body);
	if (!position) return json({ error: "position" }, 400);
	const saved = await savePosition(db, driver.id, job.booking, position);
	return json({ track: true, saved });
};
