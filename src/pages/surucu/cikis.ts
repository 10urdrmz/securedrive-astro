import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { endSession } from "../../server/driver-app";

export const POST: APIRoute = async ({ locals, cookies, redirect, request, url }) => {
	const origin = request.headers.get("origin");
	if (origin && origin !== url.origin) return new Response("Geçersiz istek kaynağı.", { status: 403 });
	await endSession(await getDb(locals), cookies);
	return redirect("/surucu/giris", 303);
};
