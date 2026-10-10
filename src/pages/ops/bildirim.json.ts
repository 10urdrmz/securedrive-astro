/** Counts and recent arrivals for the ops panel's live badges and notifications. */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { getSessionUser } from "../../server/auth/session";
import { can } from "../../server/auth/rbac";
import { opsCounts, opsFeed } from "../../server/ops-alerts";

export const GET: APIRoute = async ({ locals, cookies }) => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  };
  const db = await getDb(locals);
  const user = await getSessionUser(db, cookies, "ops");
  if (!user || !can(user, "ops.access"))
    return new Response('{"error":"auth"}', { status: 401, headers });
  const [counts, feed] = await Promise.all([
    opsCounts(db, user),
    opsFeed(db, user),
  ]);
  return new Response(JSON.stringify({ counts, feed }), { headers });
};
