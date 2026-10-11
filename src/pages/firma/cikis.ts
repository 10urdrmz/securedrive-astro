import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { destroySession } from "../../server/auth/session";

export const POST: APIRoute = async ({ locals, cookies, redirect, request, url }) => {
	const origin = request.headers.get("origin");
	if (origin && origin !== url.origin) return new Response("Geçersiz istek kaynağı.", { status: 403 });
	await destroySession(await getDb(locals), cookies, "company");
	return redirect("/firma/giris");
};
