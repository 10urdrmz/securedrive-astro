/**
 * Ties a submission to the signed-in member who sent it, so it can be listed on
 * their account page. The link is made from the session cookie of the request,
 * never from anything typed into the form: an e-mail address is not proof of who
 * is asking. Member tables are owned by the site (src/lib/members.ts).
 */
import { getDb } from "emdash/runtime";

const SESSION_COOKIE = "sd_session";

function sessionToken(request: Request): string | undefined {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === SESSION_COOKIE) {
			const token = value.join("=");
			return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
		}
	}
	return undefined;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Record that the request's member (if any) sent this inquiry. Returns what happened, for the log. */
export async function linkInquiryToMember(request: Request, inquiryId: string): Promise<"linked" | "no-cookie" | "no-session"> {
	const token = sessionToken(request);
	if (!token) return "no-cookie";

	// The member tables are not part of EmDash's typed schema.
	const db: any = await getDb();
	const now = new Date().toISOString();
	const session = await db
		.selectFrom("sd_member_sessions")
		.select(["member_id", "expires_at"])
		.where("token_hash", "=", await sha256(token))
		.executeTakeFirst();
	if (!session || session.expires_at < now) return "no-session";

	await db
		.insertInto("sd_member_requests")
		.values({ inquiry_id: inquiryId, member_id: session.member_id, created_at: now })
		.execute();
	return "linked";
}
