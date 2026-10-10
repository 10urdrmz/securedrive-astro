import type { APIRoute } from "astro";
import { NO_STORE } from "../../lib/account-page";
import { currentMember } from "../../lib/members";

/**
 * Contact details of the signed-in member, for the inquiry forms to fill in.
 * Public pages are cached and identical for everyone, so the forms ask for this
 * separately. Signed-out visitors get `{ member: null }`.
 */
export const GET: APIRoute = async ({ cookies, cache }) => {
	cache?.set(false);
	const member = await currentMember({ cookies });
	const body = { member: member && { name: member.name, phone: member.phone, email: member.email } };
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": NO_STORE },
	});
};
