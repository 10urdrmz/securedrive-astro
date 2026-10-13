/**
 * Counts and recent arrivals for the ops panel's live badges and notifications.
 * POST action=read|clear marks the bell read or empties it for this staff member.
 */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { getSessionUser } from "../../server/auth/session";
import { can } from "../../server/auth/rbac";
import { opsAlertState, opsCounts, opsFeed, unreadCount, updateOpsAlertState } from "../../server/ops-alerts";

const headers = {
	"Content-Type": "application/json",
	"Cache-Control": "no-store",
	"X-Robots-Tag": "noindex",
};

export const GET: APIRoute = async ({ locals, cookies }) => {
	const db = await getDb(locals);
	const user = await getSessionUser(db, cookies, "ops");
	if (!user || !can(user, "ops.access")) return new Response('{"error":"auth"}', { status: 401, headers });
	const state = await opsAlertState(db, user);
	const [counts, feed] = await Promise.all([opsCounts(db, user), opsFeed(db, user, state)]);
	return new Response(JSON.stringify({ counts, feed, readAt: state.readAt, unread: unreadCount(feed, state) }), { headers });
};

export const POST: APIRoute = async ({ locals, cookies, request, url }) => {
	const origin = request.headers.get("origin");
	if (origin && origin !== url.origin) return new Response('{"error":"origin"}', { status: 403, headers });
	const db = await getDb(locals);
	const user = await getSessionUser(db, cookies, "ops");
	if (!user || !can(user, "bookings.read")) return new Response('{"error":"auth"}', { status: 401, headers });
	const form = await request.formData().catch(() => null);
	const action = form?.get("action");
	if (action !== "read" && action !== "clear") return new Response('{"error":"action"}', { status: 400, headers });
	await updateOpsAlertState(db, user, action);
	// Without JavaScript the form posts here directly: go back to the page it came from.
	if (!(request.headers.get("accept") ?? "").includes("application/json")) {
		let path = "/ops";
		try {
			const back = new URL(request.headers.get("referer") ?? "");
			if (back.origin === url.origin) path = back.pathname + back.search;
		} catch {
			// No usable referrer: the panel home.
		}
		return new Response(null, { status: 303, headers: { Location: path } });
	}
	return new Response('{"ok":true}', { headers });
};
