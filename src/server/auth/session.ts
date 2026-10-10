/**
 * Cookie sessions. The browser holds a random token; D1 holds only its SHA-256.
 * Each panel has its own cookie so a passenger login never opens the ops panel.
 */
import type { AstroCookies } from "astro";
import type { Db } from "../db";
import { randomToken, sha256Hex } from "../ids";
import type { Role, SessionUser } from "./rbac";

export type Panel = "ops";

const PANELS: Record<Panel, { cookie: string; hours: number; path: string }> = {
	// One shift plus margin: ops staff sign in again every day.
	ops: { cookie: "sd_ops", hours: 12, path: "/ops" },
};

export async function createSession(db: Db, cookies: AstroCookies, userId: string, panel: Panel, userAgent: string | null) {
	const config = PANELS[panel];
	const token = randomToken();
	const expires = new Date(Date.now() + config.hours * 3600_000);
	await db
		.insertInto("sd_sessions")
		.values({
			token_hash: await sha256Hex(token),
			user_id: userId,
			panel,
			user_agent: userAgent?.slice(0, 300) ?? null,
			expires_at: expires.toISOString(),
		})
		.execute();
	cookies.set(config.cookie, token, {
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: config.path,
		expires,
	});
}

export async function getSessionUser(db: Db, cookies: AstroCookies, panel: Panel): Promise<SessionUser | null> {
	const token = cookies.get(PANELS[panel].cookie)?.value;
	if (!token) return null;
	const row = await db
		.selectFrom("sd_sessions as s")
		.innerJoin("sd_users as u", "u.id", "s.user_id")
		.select(["u.id", "u.name", "u.email", "u.status", "s.expires_at"])
		.where("s.token_hash", "=", await sha256Hex(token))
		.where("s.panel", "=", panel)
		.executeTakeFirst();
	if (!row || row.status !== "active" || row.expires_at < new Date().toISOString()) return null;
	const roles = await db.selectFrom("sd_memberships").select("role").where("user_id", "=", row.id).execute();
	return { id: row.id, name: row.name, email: row.email, roles: roles.map((r: { role: Role }) => r.role) };
}

export async function destroySession(db: Db, cookies: AstroCookies, panel: Panel) {
	const config = PANELS[panel];
	const token = cookies.get(config.cookie)?.value;
	if (token) await db.deleteFrom("sd_sessions").where("token_hash", "=", await sha256Hex(token)).execute();
	cookies.delete(config.cookie, { path: config.path });
}

/** Sign a user out everywhere, e.g. after a password change or deactivation. */
export async function destroyUserSessions(db: Db, userId: string) {
	await db.deleteFrom("sd_sessions").where("user_id", "=", userId).execute();
}
