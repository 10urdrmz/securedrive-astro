/**
 * Agencies and hotels (Faz 5.4, acente): travel agencies, tour operators, hotel front
 * desks and affiliate sites.
 *
 * Two ways to earn, both on one account:
 *  - Net price: the agency books on its own account (cari) at the tariff less its
 *    discount and sells on at its own price; we invoice the agency monthly.
 *  - Commission: the guest pays us (in the car), whether the agency booked for them in
 *    its panel or the guest came through the agency's link or widget; the agency earns
 *    a percentage of every completed trip.
 *
 * Every booking an agency made or brought carries agency_id. Referral links set a
 * 30-day cookie (sd_ref) that the website's booking wizard reads.
 */
import type { AstroGlobal, AstroCookies } from "astro";
import { sql } from "kysely";
import type { Db } from "./db";
import { getDb } from "./db";
import { can, type SessionUser } from "./auth/rbac";
import { getSessionUser } from "./auth/session";
import { ulid } from "./ids";
import { createOrgLogin } from "./org-accounts";
import { monthRange } from "./companies";

export interface AgencySettings {
	/** Discount on the tariff for bookings on the agency's account (net price). */
	discountPct: number;
	/** Commission on completed trips the guest pays for. */
	commissionPct: number;
	/** Public code in referral links and the widget. */
	refCode: string;
}

export interface Agency {
	id: string;
	name: string;
	legal_name: string | null;
	tax_no: string | null;
	status: string;
	settings: AgencySettings;
	created_at: string;
}

export const REF_COOKIE = "sd_ref";
const REF_SQL = sql<string>`json_extract(settings, '$.refCode')`;
export const REF_PATTERN = /^[a-z0-9-]{3,40}$/;
const REF_DAYS = 30;

const pct = (value: unknown) => Math.min(50, Math.max(0, Number(value) || 0));

function parseSettings(raw: string | null): AgencySettings {
	try {
		const value = JSON.parse(raw ?? "{}") as Partial<AgencySettings>;
		return { discountPct: pct(value.discountPct), commissionPct: pct(value.commissionPct), refCode: String(value.refCode ?? "") };
	} catch {
		return { discountPct: 0, commissionPct: 0, refCode: "" };
	}
}

type OrgRow = Omit<Agency, "settings"> & { settings: string };
const toAgency = (row: OrgRow): Agency => ({ ...row, settings: parseSettings(row.settings) });

export async function listAgencies(db: Db): Promise<Agency[]> {
	const rows = (await db.selectFrom("sd_orgs").selectAll().where("kind", "=", "agency").orderBy("status").orderBy("name").execute()) as OrgRow[];
	return rows.map(toAgency);
}

export async function getAgency(db: Db, id: string): Promise<Agency | null> {
	const row = (await db.selectFrom("sd_orgs").selectAll().where("id", "=", id).where("kind", "=", "agency").executeTakeFirst()) as OrgRow | undefined;
	return row ? toAgency(row) : null;
}

export async function getAgencyByRef(db: Db, refCode: string): Promise<Agency | null> {
	if (!REF_PATTERN.test(refCode)) return null;
	const row = (await db
		.selectFrom("sd_orgs")
		.selectAll()
		.where("kind", "=", "agency")
		.where("status", "=", "active")
		.where(REF_SQL, "=", refCode)
		.executeTakeFirst()) as OrgRow | undefined;
	return row ? toAgency(row) : null;
}

/** "Grand Otel Taksim" → "grand-otel-taksim", unique among agencies. */
export async function freeRefCode(db: Db, name: string): Promise<string> {
	const base =
		name
			.toLocaleLowerCase("tr")
			.replace(/ı/g, "i")
			.replace(/ğ/g, "g")
			.replace(/ü/g, "u")
			.replace(/ş/g, "s")
			.replace(/ö/g, "o")
			.replace(/ç/g, "c")
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 30) || "acente";
	for (let i = 0; i < 50; i++) {
		const code = i === 0 ? base : `${base}-${i + 1}`;
		if (code.length >= 3 && !(await getAgencyByRefAny(db, code))) return code;
	}
	return `${base}-${Date.now().toString(36)}`;
}

async function getAgencyByRefAny(db: Db, code: string) {
	return db
		.selectFrom("sd_orgs")
		.select("id")
		.where("kind", "=", "agency")
		.where(REF_SQL, "=", code)
		.executeTakeFirst();
}

export async function saveAgencySettings(db: Db, id: string, settings: AgencySettings) {
	await db.updateTable("sd_orgs").set({ settings: JSON.stringify(settings) }).where("id", "=", id).where("kind", "=", "agency").execute();
}

export async function createAgency(
	db: Db,
	input: { name: string; legalName: string | null; taxNo: string | null; discountPct: number; commissionPct: number; adminName: string; login: string },
): Promise<{ id: string; password: string; refCode: string }> {
	const login = input.login.toLowerCase();
	const taken = await db
		.selectFrom("sd_users")
		.select("id")
		.where((eb) => eb.or([eb("email", "=", login), eb("username", "=", login)]))
		.executeTakeFirst();
	if (taken) throw new Error("Bu kullanıcı adı ya da e-posta zaten kullanılıyor.");
	const id = ulid();
	const refCode = await freeRefCode(db, input.name);
	const settings: AgencySettings = { discountPct: pct(input.discountPct), commissionPct: pct(input.commissionPct), refCode };
	await db
		.insertInto("sd_orgs")
		.values({ id, kind: "agency", name: input.name, legal_name: input.legalName, tax_no: input.taxNo, settings: JSON.stringify(settings) })
		.execute();
	const { password } = await createOrgLogin(db, { orgId: id, role: "agency_admin", name: input.adminName, login });
	return { id, password, refCode };
}

/** Remembers the agency of a referral link for the next 30 days. */
export function rememberReferral(cookies: AstroCookies, refCode: string, secure: boolean) {
	if (!REF_PATTERN.test(refCode)) return;
	cookies.set(REF_COOKIE, refCode, { path: "/", httpOnly: true, sameSite: "lax", secure, maxAge: REF_DAYS * 86400 });
}

/** The agency that referred this visitor, if its link was used in the last 30 days. */
export async function referringAgency(db: Db, cookies: AstroCookies): Promise<Agency | null> {
	const code = cookies.get(REF_COOKIE)?.value ?? "";
	return code ? getAgencyByRef(db, code) : null;
}

export interface CommissionRow {
	month: string;
	trips: number;
	revenue: number;
	commission: number;
	account: number;
}

/**
 * A month's money with the agency: trips the guest paid (commission on completed ones)
 * and trips on the agency's account (what the agency owes us).
 */
export async function agencyMonth(db: Db, agency: Agency, month: string): Promise<CommissionRow> {
	const { start, end } = monthRange(month);
	const rows = await db
		.selectFrom("sd_bookings")
		.select(["status", "payment_method", "price_minor"])
		.where("agency_id", "=", agency.id)
		.where("status", "not in", ["cancelled", "quoted"])
		.where("pickup_at", ">=", start)
		.where("pickup_at", "<", end)
		.execute();
	const guestPaid = rows.filter((r) => r.payment_method !== "account" && r.status === "completed");
	const revenue = guestPaid.reduce((sum, r) => sum + r.price_minor, 0);
	return {
		month,
		trips: rows.length,
		revenue,
		commission: Math.round((revenue * agency.settings.commissionPct) / 100),
		account: rows.filter((r) => r.payment_method === "account").reduce((sum, r) => sum + r.price_minor, 0),
	};
}

export interface AgencyContext {
	db: Db;
	user: SessionUser;
	agency: Agency;
}

export async function agencyOfUser(db: Db, userId: string): Promise<Agency | null> {
	const membership = await db
		.selectFrom("sd_memberships")
		.select("org_id")
		.where("user_id", "=", userId)
		.where("role", "in", ["agency_admin", "agency_staff"])
		.executeTakeFirst();
	return membership ? getAgency(db, membership.org_id) : null;
}

/** Signed-in agency staff and their agency, or a redirect to the sign-in page. */
export async function requireAgency(Astro: AstroGlobal): Promise<AgencyContext | Response> {
	const db = await getDb(Astro.locals);
	const user = await getSessionUser(db, Astro.cookies, "agency");
	if (!user || !can(user, "agency.access")) return Astro.redirect(`/acente/giris?next=${encodeURIComponent(Astro.url.pathname)}`);
	const agency = await agencyOfUser(db, user.id);
	if (!agency || agency.status !== "active") return new Response("Acente hesabınız pasif. SecureDrive ile görüşün.", { status: 403 });
	Astro.response.headers.set("Cache-Control", "no-store");
	return { db, user, agency };
}

/** The people with a login for the agency. */
export async function agencyUsers(db: Db, orgId: string) {
	const rows = await db
		.selectFrom("sd_memberships as m")
		.innerJoin("sd_users as u", "u.id", "m.user_id")
		.select(["u.id", "u.name", "u.email", "u.username", "m.role", "u.status", "u.last_login_at"])
		.where("m.org_id", "=", orgId)
		.where("m.role", "in", ["agency_admin", "agency_staff"])
		.orderBy("m.role")
		.orderBy("u.name")
		.execute();
	return rows.map((r) => ({ id: r.id, name: r.name, login: r.email ?? r.username ?? "", role: r.role, status: r.status, last_login_at: r.last_login_at }));
}
