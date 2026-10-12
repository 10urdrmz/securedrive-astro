/**
 * Company accounts (Faz 5.3, kurumsal): firms that book transfers for their staff and
 * guests on account. Ops opens the account with the contract terms (discount, monthly
 * limit, allowed vehicle classes) and its first admin login; the company books in its
 * panel at /firma and gets a monthly statement. Invoicing (e-Fatura) comes later.
 */
import type { AstroGlobal } from "astro";
import type { Db } from "./db";
import { getDb } from "./db";
import { can, type SessionUser } from "./auth/rbac";
import { getSessionUser } from "./auth/session";
import { ulid } from "./ids";
import { createOrgLogin } from "./org-accounts";
import type { ClassQuote, Quote } from "./pricing";

export interface CompanySettings {
	/** Contract discount on the public tariff, in percent. */
	discountPct: number;
	/** Monthly spending cap; null for no cap. */
	monthlyLimitMinor: number | null;
	/** Vehicle classes the company may book; empty means all. */
	classes: string[];
}

export interface Company {
	id: string;
	name: string;
	legal_name: string | null;
	tax_no: string | null;
	status: string;
	settings: CompanySettings;
	created_at: string;
}

const DEFAULTS: CompanySettings = { discountPct: 0, monthlyLimitMinor: null, classes: [] };

function parseSettings(raw: string | null): CompanySettings {
	try {
		const value = JSON.parse(raw ?? "{}") as Partial<CompanySettings>;
		return {
			discountPct: Math.min(50, Math.max(0, Number(value.discountPct) || 0)),
			monthlyLimitMinor: value.monthlyLimitMinor ? Number(value.monthlyLimitMinor) : null,
			classes: Array.isArray(value.classes) ? value.classes.map(String) : [],
		};
	} catch {
		return { ...DEFAULTS };
	}
}

type OrgRow = Omit<Company, "settings"> & { settings: string };
const toCompany = (row: OrgRow): Company => ({ ...row, settings: parseSettings(row.settings) });

export async function listCompanies(db: Db): Promise<Company[]> {
	const rows = (await db.selectFrom("sd_orgs").selectAll().where("kind", "=", "company").orderBy("status").orderBy("name").execute()) as OrgRow[];
	return rows.map(toCompany);
}

export async function getCompany(db: Db, id: string): Promise<Company | null> {
	const row = (await db.selectFrom("sd_orgs").selectAll().where("id", "=", id).where("kind", "=", "company").executeTakeFirst()) as OrgRow | undefined;
	return row ? toCompany(row) : null;
}

export async function saveCompanySettings(db: Db, id: string, settings: CompanySettings) {
	await db.updateTable("sd_orgs").set({ settings: JSON.stringify(settings) }).where("id", "=", id).where("kind", "=", "company").execute();
}

/** Opens a company account and its first admin login. Returns the password to pass on. */
export async function createCompany(
	db: Db,
	input: { name: string; legalName: string | null; taxNo: string | null; settings: CompanySettings; adminName: string; login: string },
): Promise<{ id: string; password: string }> {
	const login = input.login.toLowerCase();
	const taken = await db
		.selectFrom("sd_users")
		.select("id")
		.where((eb) => eb.or([eb("email", "=", login), eb("username", "=", login)]))
		.executeTakeFirst();
	if (taken) throw new Error("Bu kullanıcı adı ya da e-posta zaten kullanılıyor.");
	const id = ulid();
	await db
		.insertInto("sd_orgs")
		.values({ id, kind: "company", name: input.name, legal_name: input.legalName, tax_no: input.taxNo, settings: JSON.stringify(input.settings) })
		.execute();
	const { password } = await createOrgLogin(db, { orgId: id, role: "company_admin", name: input.adminName, login });
	return { id, password };
}

export interface CompanyUser {
	id: string;
	name: string;
	login: string;
	role: string;
	status: string;
	last_login_at: string | null;
}

export async function companyUsers(db: Db, orgId: string): Promise<CompanyUser[]> {
	const rows = await db
		.selectFrom("sd_memberships as m")
		.innerJoin("sd_users as u", "u.id", "m.user_id")
		.select(["u.id", "u.name", "u.email", "u.username", "m.role", "u.status", "u.last_login_at"])
		.where("m.org_id", "=", orgId)
		.where("m.role", "in", ["company_admin", "company_booker"])
		.orderBy("m.role")
		.orderBy("u.name")
		.execute();
	return rows.map((r) => ({ id: r.id, name: r.name, login: r.email ?? r.username ?? "", role: r.role, status: r.status, last_login_at: r.last_login_at }));
}

/** First and last instant of an Istanbul calendar month ("2026-10"), as UTC ISO strings. */
export function monthRange(month: string) {
	const [y, m] = month.split("-").map(Number);
	const start = new Date(Date.UTC(y, m - 1, 1) - 3 * 3600_000).toISOString();
	const end = new Date(Date.UTC(y, m, 1) - 3 * 3600_000).toISOString();
	return { start, end };
}

export const currentMonth = (now = Date.now()) => new Date(now + 3 * 3600_000).toISOString().slice(0, 7);

export const monthName = (month: string) =>
	new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

/** What the company has booked for trips in a month, cancellations left out. */
export async function monthSpend(db: Db, orgId: string, month = currentMonth(), by: "org_id" | "agency_id" = "org_id"): Promise<{ total: number; trips: number }> {
	const { start, end } = monthRange(month);
	const row = await db
		.selectFrom("sd_bookings")
		.select((eb) => [eb.fn.coalesce(eb.fn.sum<number>("price_minor"), eb.lit(0)).as("total"), eb.fn.countAll<number>().as("trips")])
		.where(by, "=", orgId)
		.where("status", "not in", ["cancelled", "quoted", "bidding"])
		.where("pickup_at", ">=", start)
		.where("pickup_at", "<", end)
		.executeTakeFirst();
	return { total: Number(row?.total ?? 0), trips: Number(row?.trips ?? 0) };
}

/** The classes a company may book, with its contract discount as a price line. */
export function companyOptions(company: Company, quote: Quote): ClassQuote[] {
	const { discountPct, classes } = company.settings;
	return quote.options
		.filter((o) => classes.length === 0 || classes.includes(o.classKey))
		.map((o) => {
			if (!discountPct) return o;
			const discount = -Math.round((o.total_minor * discountPct) / 100);
			return { ...o, lines: [...o.lines, { kind: "discount" as const, label: `Kurumsal indirim (%${discountPct})`, amount_minor: discount }], total_minor: o.total_minor + discount };
		});
}

export interface CompanyTrip {
	id: string;
	code: string;
	status: string;
	pickup_at: string;
	from_name: string;
	to_name: string;
	class_name: string;
	contact_name: string;
	contact_phone: string;
	flight_no: string | null;
	cost_center: string | null;
	price_minor: number;
	tracking_token: string;
	booked_by: string | null;
	pax: number;
	payment_method: string;
	source: string;
}

/** Trips billed to a company (org_id), or brought by an agency (agency_id). */
export async function companyTrips(
	db: Db,
	orgId: string,
	filter: { month?: string; upcoming?: boolean; limit?: number } = {},
	by: "org_id" | "agency_id" = "org_id",
): Promise<CompanyTrip[]> {
	let query = db
		.selectFrom("sd_bookings as b")
		.innerJoin("sd_zones as f", "f.id", "b.from_zone_id")
		.innerJoin("sd_zones as t", "t.id", "b.to_zone_id")
		.innerJoin("sd_vehicle_classes as c", "c.key", "b.class_key")
		.leftJoin("sd_users as u", "u.id", "b.created_by")
		.select([
			"b.id",
			"b.code",
			"b.status",
			"b.pickup_at",
			"f.name as from_name",
			"t.name as to_name",
			"c.name as class_name",
			"b.contact_name",
			"b.contact_phone",
			"b.flight_no",
			"b.cost_center",
			"b.price_minor",
			"b.tracking_token",
			"u.name as booked_by",
			"b.pax",
			"b.payment_method",
			"b.source",
		])
		.where(`b.${by}`, "=", orgId);
	if (filter.month) {
		const { start, end } = monthRange(filter.month);
		query = query.where("b.pickup_at", ">=", start).where("b.pickup_at", "<", end).orderBy("b.pickup_at");
	} else if (filter.upcoming) {
		query = query
			.where("b.pickup_at", ">=", new Date(Date.now() - 6 * 3600_000).toISOString())
			.where("b.status", "not in", ["completed", "cancelled", "no_show"])
			.orderBy("b.pickup_at");
	} else {
		query = query.orderBy("b.pickup_at", "desc");
	}
	return (await query.limit(filter.limit ?? 500).execute()) as CompanyTrip[];
}

export interface CompanyContext {
	db: Db;
	user: SessionUser;
	company: Company;
}

/** Signed-in company staff and their company, or a redirect to the sign-in page. */
export async function requireCompany(Astro: AstroGlobal): Promise<CompanyContext | Response> {
	const db = await getDb(Astro.locals);
	const user = await getSessionUser(db, Astro.cookies, "company");
	if (!user || !can(user, "company.access")) return Astro.redirect(`/firma/giris?next=${encodeURIComponent(Astro.url.pathname)}`);
	const membership = await db
		.selectFrom("sd_memberships")
		.select("org_id")
		.where("user_id", "=", user.id)
		.where("role", "in", ["company_admin", "company_booker"])
		.executeTakeFirst();
	const company = membership ? await getCompany(db, membership.org_id) : null;
	if (!company || company.status !== "active") return new Response("Firma hesabınız pasif. SecureDrive ile görüşün.", { status: 403 });
	Astro.response.headers.set("Cache-Control", "no-store");
	return { db, user, company };
}
