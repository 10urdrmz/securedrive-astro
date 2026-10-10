/**
 * Shared plumbing for /ops pages: authentication, permission checks, POST handling,
 * audit logging and money formatting.
 */
import type { AstroGlobal } from "astro";
import { getDb, type Db } from "./db";
import { can, type Permission, type SessionUser } from "./auth/rbac";
import { getSessionUser } from "./auth/session";
import { ulid } from "./ids";

export interface OpsContext {
	db: Db;
	user: SessionUser;
}

/**
 * Returns the signed-in ops user, or a Response the page must return as-is
 * (redirect to sign-in, or 403 when the role lacks the permission).
 */
export async function requireOps(Astro: AstroGlobal, permission: Permission = "ops.access"): Promise<OpsContext | Response> {
	const db = await getDb(Astro.locals);
	const user = await getSessionUser(db, Astro.cookies, "ops");
	if (!user || !can(user, "ops.access")) {
		const next = encodeURIComponent(Astro.url.pathname);
		return Astro.redirect(`/ops/giris?next=${next}`);
	}
	if (!can(user, permission)) return new Response("Bu sayfa için yetkiniz yok.", { status: 403 });
	return { db, user };
}

/**
 * A POST we accept: same-origin only. SameSite=Lax already keeps cross-site cookies off
 * POSTs; the Origin check is the second lock.
 */
export async function readForm(Astro: AstroGlobal): Promise<FormData | null> {
	if (Astro.request.method !== "POST") return null;
	const origin = Astro.request.headers.get("origin");
	if (origin && origin !== Astro.url.origin) return null;
	return Astro.request.formData();
}

export function text(form: FormData, key: string, max = 200): string {
	const value = form.get(key);
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export async function audit(db: Db, actor: SessionUser | null, action: string, entity: string, entityId: string | null, data: unknown = {}) {
	await db
		.insertInto("sd_audit_log")
		.values({ id: ulid(), actor_user_id: actor?.id ?? null, action, entity, entity_id: entityId, data: JSON.stringify(data) })
		.execute();
}

/** "1.250,50" or "1250.5" or "1250" (TL) → 125050 kuruş. Empty or invalid → null. */
export function parseMoney(value: string): number | null {
	const cleaned = value.replace(/\s|₺|TL/gi, "");
	if (!cleaned) return null;
	// Turkish: "1.250,50" and "1.250" use dots for thousands; "1250.50" is accepted too.
	const normalized = cleaned.includes(",")
		? cleaned.replace(/\./g, "").replace(",", ".")
		: /^\d{1,3}(\.\d{3})+$/.test(cleaned)
			? cleaned.replace(/\./g, "")
			: cleaned;
	if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
	return Math.round(Number(normalized) * 100);
}

/** 125050 → "1.250,50" (no currency sign; for inputs and tables). */
export function formatMoney(minor: number | null | undefined): string {
	if (minor == null) return "";
	return new Intl.NumberFormat("tr-TR", { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(minor / 100);
}
