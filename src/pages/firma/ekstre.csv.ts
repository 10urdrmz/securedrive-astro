/** The monthly statement as CSV (semicolon-separated, UTF-8 BOM so Excel opens it in Turkish). */
import type { APIRoute } from "astro";
import { getDb } from "../../server/db";
import { can } from "../../server/auth/rbac";
import { getSessionUser } from "../../server/auth/session";
import { companyTrips, currentMonth, getCompany } from "../../server/companies";
import { STATUS_LABELS, type BookingStatus } from "../../server/bookings";
import { isoToIstanbul } from "../../server/pricing";

export const GET: APIRoute = async ({ locals, cookies, url }) => {
	const db = await getDb(locals);
	const user = await getSessionUser(db, cookies, "company");
	if (!user || !can(user, "company.access")) return new Response("Giriş gerekli.", { status: 401 });
	const membership = await db
		.selectFrom("sd_memberships")
		.select("org_id")
		.where("user_id", "=", user.id)
		.where("role", "in", ["company_admin", "company_booker"])
		.executeTakeFirst();
	const company = membership ? await getCompany(db, membership.org_id) : null;
	if (!company || company.status !== "active") return new Response("Firma hesabı pasif.", { status: 403 });

	const asked = url.searchParams.get("ay") ?? "";
	const month = /^\d{4}-\d{2}$/.test(asked) ? asked : currentMonth();
	const trips = (await companyTrips(db, company.id, { month })).filter((t) => !["cancelled", "quoted"].includes(t.status));
	// Leading = + - @ would make Excel treat a cell as a formula.
	const cell = (value: string | number | null) => {
		const s = String(value ?? "").replace(/^[=+\-@]/, "'$&");
		return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const rows = [
		["Tarih", "Saat", "Kod", "Yolcu", "Nereden", "Nereye", "Araç", "Kişi", "Uçuş", "Masraf merkezi", "Ayıran", "Durum", "Tutar (TL)"],
		...trips.map((t) => {
			const { date, time } = isoToIstanbul(t.pickup_at);
			return [
				date.split("-").reverse().join("."),
				time,
				t.code,
				t.contact_name,
				t.from_name,
				t.to_name,
				t.class_name,
				t.pax,
				t.flight_no,
				t.cost_center,
				t.booked_by,
				STATUS_LABELS[t.status as BookingStatus] ?? t.status,
				(t.price_minor / 100).toFixed(2).replace(".", ","),
			];
		}),
	];
	const body = "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
	return new Response(body, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="securedrive-ekstre-${month}.csv"`,
			"Cache-Control": "no-store",
		},
	});
};
