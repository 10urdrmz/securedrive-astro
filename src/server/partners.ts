/**
 * Partner fleets (Faz 5): transfer companies with their own drivers and vehicles.
 *
 * Ops gives a booking to a partner with the amount the partner earns; the partner
 * accepts or declines in /partner and then picks one of its own drivers, who works
 * the trip in the normal driver app. Partners never see the passenger's price, phone
 * or e-mail: they see the trip, the passenger's name and their own payout.
 *
 * A partner's drivers carry its org_id and wait for our approval before they can be
 * given work or a PIN.
 */
import type { AstroGlobal } from "astro";
import type { Db } from "./db";
import { getDb } from "./db";
import { addEvent, assignDriver, ConflictError, FINAL_STATUSES, getBookingByCode, updateBooking, type Actor, type Booking } from "./bookings";
import { can, type SessionUser } from "./auth/rbac";
import { getSessionUser } from "./auth/session";
import { ulid } from "./ids";
import { createOrgLogin, resetLogin } from "./org-accounts";

export interface Partner {
	id: string;
	name: string;
	legal_name: string | null;
	tax_no: string | null;
	status: string;
	settings: string;
	created_at: string;
}

export interface CarrierJob {
	id: string;
	booking_id: string;
	org_id: string;
	payout_minor: number;
	status: "offered" | "accepted" | "declined" | "released";
	note: string | null;
	offered_at: string;
	responded_at: string | null;
}

export const CARRIER_JOB_LABELS: Record<CarrierJob["status"], string> = {
	offered: "Partnerin cevabı bekleniyor",
	accepted: "Partner kabul etti",
	declined: "Partner reddetti",
	released: "Partnerden geri alındı",
};

/** How long a partner has to answer before ops is told. */
export const PARTNER_ANSWER_MINUTES = 15;

export async function listPartners(db: Db): Promise<Partner[]> {
	return (await db.selectFrom("sd_orgs").selectAll().where("kind", "=", "carrier").orderBy("status").orderBy("name").execute()) as Partner[];
}

export async function getPartner(db: Db, id: string): Promise<Partner | null> {
	return ((await db.selectFrom("sd_orgs").selectAll().where("id", "=", id).where("kind", "=", "carrier").executeTakeFirst()) as Partner | undefined) ?? null;
}

/** Create a partner company and its first manager login. Returns the password to pass on. */
export async function createPartner(
	db: Db,
	input: { name: string; legalName: string | null; taxNo: string | null; contactName: string; login: string },
): Promise<{ id: string; password: string }> {
	const taken = await db
		.selectFrom("sd_users")
		.select("id")
		.where((eb) => eb.or([eb("email", "=", input.login.toLowerCase()), eb("username", "=", input.login.toLowerCase())]))
		.executeTakeFirst();
	if (taken) throw new Error("Bu kullanıcı adı ya da e-posta zaten kullanılıyor.");
	const orgId = ulid();
	await db.insertInto("sd_orgs").values({ id: orgId, kind: "carrier", name: input.name, legal_name: input.legalName, tax_no: input.taxNo }).execute();
	const { password } = await createOrgLogin(db, { orgId, role: "carrier_admin", name: input.contactName, login: input.login });
	return { id: orgId, password };
}

/** A fresh password for a partner's manager(s); the old one stops working. */
export async function resetPartnerPassword(db: Db, orgId: string): Promise<{ login: string; password: string } | null> {
	const member = await db
		.selectFrom("sd_memberships")
		.select("user_id")
		.where("org_id", "=", orgId)
		.where("role", "=", "carrier_admin")
		.orderBy("created_at")
		.executeTakeFirst();
	return member ? resetLogin(db, member.user_id) : null;
}

/** The partner's live job on a booking: offered or accepted. */
export async function currentCarrierJob(db: Db, bookingId: string): Promise<CarrierJob | null> {
	return (
		((await db
			.selectFrom("sd_carrier_jobs")
			.selectAll()
			.where("booking_id", "=", bookingId)
			.where("status", "in", ["offered", "accepted"])
			.orderBy("offered_at", "desc")
			.executeTakeFirst()) as CarrierJob | undefined) ?? null
	);
}

/** Ops gives a booking to a partner. Any driver already on it is taken off. */
export async function offerToPartner(db: Db, booking: Booking, orgId: string, payoutMinor: number, actor: Actor, note: string | null = null) {
	if (FINAL_STATUSES.includes(booking.status)) throw new Error("Kapanmış bir rezervasyon partnere verilemez.");
	if (booking.status === "quoted") throw new Error("Müşteri teklifi onaylamadan iş partnere verilemez.");
	if (!(payoutMinor > 0)) throw new Error("Partnerin alacağı tutarı yazın.");
	const partner = await getPartner(db, orgId);
	if (!partner || partner.status !== "active") throw new Error("Partner bulunamadı ya da pasif.");
	if (booking.driver_id) {
		await assignDriver(db, booking, null, actor);
		booking = (await getBookingByCode(db, booking.code))!;
	}
	const now = new Date().toISOString();
	await db.updateTable("sd_carrier_jobs").set({ status: "released", responded_at: now }).where("booking_id", "=", booking.id).where("status", "in", ["offered", "accepted"]).execute();
	await updateBooking(db, booking, { carrier_org_id: orgId, payout_minor: payoutMinor });
	await db
		.insertInto("sd_carrier_jobs")
		.values({ id: ulid(), booking_id: booking.id, org_id: orgId, payout_minor: payoutMinor, status: "offered", note, offered_by: actor.userId ?? null, offered_at: now })
		.execute();
	await addEvent(db, booking.id, actor, "carrier_offered", null, null, { orgId, partnerName: partner.name, payoutMinor });
}

/** Ops takes the job back from the partner (and off the partner's driver). */
export async function withdrawFromPartner(db: Db, booking: Booking, actor: Actor) {
	const job = await currentCarrierJob(db, booking.id);
	if (!job && !booking.carrier_org_id) return;
	if (booking.driver_id) {
		await assignDriver(db, booking, null, actor);
		booking = (await getBookingByCode(db, booking.code))!;
	}
	await db.updateTable("sd_carrier_jobs").set({ status: "released", responded_at: new Date().toISOString() }).where("booking_id", "=", booking.id).where("status", "in", ["offered", "accepted"]).execute();
	await updateBooking(db, booking, { carrier_org_id: null });
	const partner = job ? await getPartner(db, job.org_id) : null;
	await addEvent(db, booking.id, actor, "carrier_released", null, null, { orgId: job?.org_id ?? booking.carrier_org_id, partnerName: partner?.name ?? null });
}

/** The partner accepts or declines a job it was offered. */
export async function partnerRespond(db: Db, booking: Booking, orgId: string, accept: boolean, actor: Actor) {
	const job = await currentCarrierJob(db, booking.id);
	if (!job || job.org_id !== orgId || booking.carrier_org_id !== orgId) throw new Error("Bu iş artık size ait değil.");
	if (job.status !== "offered") throw new Error("Bu işe zaten cevap verdiniz.");
	const now = new Date().toISOString();
	const result = await db
		.updateTable("sd_carrier_jobs")
		.set({ status: accept ? "accepted" : "declined", responded_at: now, responded_by: actor.userId ?? null })
		.where("id", "=", job.id)
		.where("status", "=", "offered")
		.executeTakeFirst();
	if (Number(result.numUpdatedRows ?? 0) !== 1) throw new ConflictError();
	if (!accept) await updateBooking(db, booking, { carrier_org_id: null });
	const partner = await getPartner(db, orgId);
	await addEvent(db, booking.id, actor, accept ? "carrier_accepted" : "carrier_declined", null, null, { orgId, partnerName: partner?.name ?? null });
}

/** The partner puts one of its own approved drivers on an accepted job (or takes them off). */
export async function partnerAssign(db: Db, booking: Booking, orgId: string, driverId: string | null, actor: Actor) {
	const job = await currentCarrierJob(db, booking.id);
	if (!job || job.org_id !== orgId || booking.carrier_org_id !== orgId) throw new Error("Bu iş artık size ait değil.");
	if (job.status !== "accepted") throw new Error("Önce işi kabul edin.");
	if (driverId) {
		const driver = await db
			.selectFrom("sd_drivers")
			.select(["id"])
			.where("id", "=", driverId)
			.where("org_id", "=", orgId)
			.where("approval", "=", "approved")
			.where("status", "=", "active")
			.executeTakeFirst();
		if (!driver) throw new Error("Bu sürücü atanamaz: onaylı ve aktif kendi sürücünüz olmalı.");
	}
	await assignDriver(db, booking, driverId, actor);
}

export interface PartnerJobRow {
	booking_id: string;
	code: string;
	status: Booking["status"];
	pickup_at: string;
	pickup_address: string | null;
	dropoff_address: string | null;
	flight_no: string | null;
	pax: number;
	bags: number;
	contact_name: string;
	sign_name: string | null;
	notes: string | null;
	payment_method: string;
	payment_status: string;
	driver_id: string | null;
	driver_name: string | null;
	from_name: string;
	to_name: string;
	class_name: string;
	job_status: CarrierJob["status"];
	job_note: string | null;
	payout_minor: number;
	offered_at: string;
}

/**
 * A partner's jobs. Only what the partner needs: never the passenger's price, phone
 * or e-mail, never anybody else's job.
 */
export async function partnerJobs(db: Db, orgId: string, scope: "open" | "done", limit = 100): Promise<PartnerJobRow[]> {
	let query = db
		.selectFrom("sd_carrier_jobs as j")
		.innerJoin("sd_bookings as b", "b.id", "j.booking_id")
		.innerJoin("sd_zones as f", "f.id", "b.from_zone_id")
		.innerJoin("sd_zones as t", "t.id", "b.to_zone_id")
		.innerJoin("sd_vehicle_classes as c", "c.key", "b.class_key")
		.leftJoin("sd_drivers as d", "d.id", "b.driver_id")
		.select([
			"b.id as booking_id",
			"b.code",
			"b.status",
			"b.pickup_at",
			"b.pickup_address",
			"b.dropoff_address",
			"b.flight_no",
			"b.pax",
			"b.bags",
			"b.contact_name",
			"b.sign_name",
			"b.notes",
			"b.payment_method",
			"b.payment_status",
			"b.driver_id",
			"d.name as driver_name",
			"f.name as from_name",
			"t.name as to_name",
			"c.name as class_name",
			"j.status as job_status",
			"j.note as job_note",
			"j.payout_minor",
			"j.offered_at",
		])
		.where("j.org_id", "=", orgId)
		.where("b.carrier_org_id", "=", orgId);
	query =
		scope === "open"
			? query.where("j.status", "in", ["offered", "accepted"]).where("b.status", "not in", ["completed", "cancelled", "no_show"]).orderBy("b.pickup_at")
			: query.where("j.status", "=", "accepted").where("b.status", "=", "completed").orderBy("b.pickup_at", "desc");
	return (await query.limit(limit).execute()) as PartnerJobRow[];
}

export interface PartnerContext {
	db: Db;
	user: SessionUser;
	org: Partner;
}

/** Signed-in partner staff and their company, or a redirect to the sign-in page. */
export async function requirePartner(Astro: AstroGlobal): Promise<PartnerContext | Response> {
	const db = await getDb(Astro.locals);
	const user = await getSessionUser(db, Astro.cookies, "partner");
	if (!user || !can(user, "partner.access")) return Astro.redirect(`/partner/giris?next=${encodeURIComponent(Astro.url.pathname)}`);
	const membership = await db
		.selectFrom("sd_memberships")
		.select("org_id")
		.where("user_id", "=", user.id)
		.where("role", "=", "carrier_admin")
		.executeTakeFirst();
	const org = membership ? await getPartner(db, membership.org_id) : null;
	if (!org || org.status !== "active") return new Response("Partner hesabınız pasif. SecureDrive operasyonla görüşün.", { status: 403 });
	Astro.response.headers.set("Cache-Control", "no-store");
	return { db, user, org };
}
