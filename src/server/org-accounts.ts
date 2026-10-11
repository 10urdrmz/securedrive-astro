/**
 * Logins for outside organisations (partner fleets, company accounts): SecureDrive
 * opens them and hands the one-off password over; there is no self sign-up.
 */
import type { Db } from "./db";
import { hashPassword } from "./auth/password";
import { randomToken, ulid } from "./ids";

/** An easy-to-type one-off password, shown once. */
export const newPassword = () => randomToken(9).replace(/[^A-Za-z0-9]/g, "").slice(0, 12).padEnd(12, "7");

/** Login names are e-mail addresses or simple user names. */
export const LOGIN_PATTERN = /^[a-z0-9._@+-]{3,120}$/;

/** A user with a membership in an organisation. Returns the password to pass on. */
export async function createOrgLogin(db: Db, input: { orgId: string; role: string; name: string; login: string }): Promise<{ userId: string; password: string }> {
	const login = input.login.toLowerCase();
	const taken = await db
		.selectFrom("sd_users")
		.select("id")
		.where((eb) => eb.or([eb("email", "=", login), eb("username", "=", login)]))
		.executeTakeFirst();
	if (taken) throw new Error("Bu kullanıcı adı ya da e-posta zaten kullanılıyor.");
	const userId = ulid();
	const password = newPassword();
	await db
		.insertInto("sd_users")
		.values({
			id: userId,
			name: input.name,
			email: login.includes("@") ? login : null,
			username: login.includes("@") ? null : login,
			password_hash: await hashPassword(password),
		})
		.execute();
	await db.insertInto("sd_memberships").values({ id: ulid(), user_id: userId, org_id: input.orgId, role: input.role }).execute();
	return { userId, password };
}

/** A fresh password; the old one and any open sessions stop working. */
export async function resetLogin(db: Db, userId: string): Promise<{ login: string; password: string } | null> {
	const user = await db.selectFrom("sd_users").select(["id", "email", "username"]).where("id", "=", userId).executeTakeFirst();
	if (!user) return null;
	const password = newPassword();
	await db
		.updateTable("sd_users")
		.set({ password_hash: await hashPassword(password), failed_logins: 0, locked_until: null, status: "active" })
		.where("id", "=", user.id)
		.execute();
	await db.deleteFrom("sd_sessions").where("user_id", "=", user.id).execute();
	return { login: user.email ?? user.username ?? "", password };
}
