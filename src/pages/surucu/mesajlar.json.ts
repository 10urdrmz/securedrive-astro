/** The driver's message thread for one of their jobs: GET ?code=. Reading marks it read. */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { driverJob, sessionDriver } from "../../server/driver-app";
import { canWrite, chatJson, listMessages, markRead } from "../../server/messages";

export const GET: APIRoute = async ({ locals, cookies, url }) => {
	const db = await getDb(locals);
	const driver = await sessionDriver(db, cookies);
	if (!driver) return new Response('{"error":"auth"}', { status: 401, headers: { "Content-Type": "application/json" } });
	const job = await driverJob(db, driver.id, (url.searchParams.get("code") ?? "").toUpperCase().slice(0, 20));
	if (!job) return new Response('{"error":"not_found"}', { status: 404, headers: { "Content-Type": "application/json" } });
	const messages = await listMessages(db, job.booking, "driver");
	await markRead(db, job.booking.id, "driver");
	return chatJson(messages, canWrite(job.booking, "driver"));
};
