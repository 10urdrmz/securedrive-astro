/**
 * Job pool (Faz 6, Mod B, ihale): ops puts a booking out to the partner fleets.
 *
 *  - fixed: a set payout; the first partner to take it gets it.
 *  - auction: a ceiling payout and a deadline; partners bid at or under the ceiling
 *    and may change or withdraw their bid; at the deadline the lowest bid wins (ties:
 *    the earlier bid). Ops may also award any bid earlier by hand.
 *
 * Winning turns into the normal partner flow: the job is the partner's, accepted, at
 * the winning amount, and the partner puts one of its drivers on it. Partners never
 * see the passenger's price, phone or e-mail here either, nor each other's bids.
 *
 * Deadlines are settled from the middleware at most once a minute, like dispatch.
 */
import type { Db } from "./db";
import { addEvent, FINAL_STATUSES, getBookingByCode, type Actor, type Booking } from "./bookings";
import { getPartner, offerToPartner } from "./partners";
import { ulid } from "./ids";

export type PoolMode = "fixed" | "auction";

export interface PoolJob {
	id: string;
	booking_id: string;
	mode: PoolMode;
	payout_minor: number;
	deadline_at: string;
	status: "open" | "awarded" | "cancelled" | "expired";
	note: string | null;
	created_at: string;
	closed_at: string | null;
	winner_kind: string | null;
	winner_id: string | null;
	winner_amount_minor: number | null;
}

export interface PoolBid {
	id: string;
	pool_job_id: string;
	bidder_kind: "partner" | "driver";
	bidder_id: string;
	amount_minor: number;
	note: string | null;
	status: "active" | "withdrawn" | "won" | "lost";
	created_at: string;
	updated_at: string;
}

export const POOL_STATUS_LABELS: Record<PoolJob["status"], string> = {
	open: "Havuzda",
	awarded: "Verildi",
	cancelled: "Havuzdan çekildi",
	expired: "Teklif gelmedi",
};

const SYSTEM: Actor = { kind: "system", userId: null };

export async function currentPoolJob(db: Db, bookingId: string): Promise<PoolJob | null> {
	return (
		((await db
			.selectFrom("sd_pool_jobs")
			.selectAll()
			.where("booking_id", "=", bookingId)
			.orderBy("created_at", "desc")
			.executeTakeFirst()) as PoolJob | undefined) ?? null
	);
}

export async function poolBids(db: Db, poolJobId: string) {
	return db
		.selectFrom("sd_pool_bids as p")
		.leftJoin("sd_orgs as o", (join) => join.onRef("o.id", "=", "p.bidder_id").on("p.bidder_kind", "=", "partner"))
		.leftJoin("sd_drivers as d", (join) => join.onRef("d.id", "=", "p.bidder_id").on("p.bidder_kind", "=", "driver"))
		.selectAll("p")
		.select((eb) => eb.fn.coalesce("o.name", "d.name").as("bidder_name"))
		.where("p.pool_job_id", "=", poolJobId)
		.orderBy("p.status")
		.orderBy("p.amount_minor")
		.orderBy("p.updated_at")
		.execute() as Promise<(PoolBid & { bidder_name: string | null })[]>;
}

/** Ops puts a booking out to the pool. */
export async function openPool(
	db: Db,
	booking: Booking,
	input: { mode: PoolMode; payoutMinor: number; deadlineMinutes: number; note: string | null },
	actor: Actor,
): Promise<PoolJob> {
	if (FINAL_STATUSES.includes(booking.status)) throw new Error("Kapanmış bir rezervasyon havuza konamaz.");
	if (booking.status === "quoted") throw new Error("Müşteri teklifi onaylamadan iş havuza konamaz.");
	if (booking.driver_id || booking.carrier_org_id) throw new Error("Önce sürücüyü ya da partneri işten alın.");
	if (!(input.payoutMinor > 0)) throw new Error("Havuz tutarını yazın.");
	const current = await currentPoolJob(db, booking.id);
	if (current?.status === "open") throw new Error("Bu iş zaten havuzda.");
	const now = Date.now();
	// The pool closes no later than two hours before pickup, so the winner has time to send a driver.
	const latest = Date.parse(booking.pickup_at) - 2 * 3600_000;
	if (latest <= now + 5 * 60_000) throw new Error("Alışa çok az kaldı; bu işi doğrudan atayın.");
	const deadline = new Date(Math.min(now + input.deadlineMinutes * 60_000, latest)).toISOString();
	const job: PoolJob = {
		id: ulid(),
		booking_id: booking.id,
		mode: input.mode,
		payout_minor: input.payoutMinor,
		deadline_at: deadline,
		status: "open",
		note: input.note,
		created_at: new Date(now).toISOString(),
		closed_at: null,
		winner_kind: null,
		winner_id: null,
		winner_amount_minor: null,
	};
	await db
		.insertInto("sd_pool_jobs")
		.values({ ...job, created_by: actor.userId ?? null })
		.execute();
	await addEvent(db, booking.id, actor, "pool_opened", null, null, { mode: input.mode, payout_minor: input.payoutMinor, deadline });
	return job;
}

/** Ops takes a booking back out of the pool. */
export async function cancelPool(db: Db, job: PoolJob, actor: Actor) {
	if (job.status !== "open") return;
	const now = new Date().toISOString();
	await db.updateTable("sd_pool_jobs").set({ status: "cancelled", closed_at: now }).where("id", "=", job.id).where("status", "=", "open").execute();
	await db.updateTable("sd_pool_bids").set({ status: "lost", updated_at: now }).where("pool_job_id", "=", job.id).where("status", "=", "active").execute();
	await addEvent(db, job.booking_id, actor, "pool_cancelled", null, null, {});
}

/**
 * Hands the pooled job to the winner. Claims the pool row first, so two people (or
 * isolates) awarding at the same time cannot both win.
 */
async function award(db: Db, job: PoolJob, winner: { kind: "partner" | "driver"; id: string; amountMinor: number; bidId: string | null }, actor: Actor) {
	const now = new Date().toISOString();
	const claimed = await db
		.updateTable("sd_pool_jobs")
		.set({ status: "awarded", closed_at: now, winner_kind: winner.kind, winner_id: winner.id, winner_amount_minor: winner.amountMinor })
		.where("id", "=", job.id)
		.where("status", "=", "open")
		.executeTakeFirst();
	if (Number(claimed.numUpdatedRows ?? 0) !== 1) throw new Error("Bu iş artık havuzda değil.");
	await db
		.updateTable("sd_pool_bids")
		.set((eb) => ({ status: winner.bidId ? eb.case().when("id", "=", winner.bidId).then("won").else("lost").end() : "lost", updated_at: now }))
		.where("pool_job_id", "=", job.id)
		.where("status", "=", "active")
		.execute();
	const bookingRow = await db.selectFrom("sd_bookings").select("code").where("id", "=", job.booking_id).executeTakeFirstOrThrow();
	const booking = (await getBookingByCode(db, bookingRow.code))!;
	if (winner.kind === "partner") {
		await offerToPartner(db, booking, winner.id, winner.amountMinor, actor, job.note);
		await db
			.updateTable("sd_carrier_jobs")
			.set({ status: "accepted", responded_at: now })
			.where("booking_id", "=", booking.id)
			.where("org_id", "=", winner.id)
			.where("status", "=", "offered")
			.execute();
		const partner = await getPartner(db, winner.id);
		await addEvent(db, booking.id, actor, "pool_awarded", null, null, { orgId: winner.id, partnerName: partner?.name ?? null, amount_minor: winner.amountMinor });
	}
}

/** A partner takes a fixed-payout job: first come, first served. */
export async function takeFixed(db: Db, job: PoolJob, orgId: string, actor: Actor) {
	if (job.mode !== "fixed" || job.status !== "open") throw new Error("Bu iş artık havuzda değil.");
	if (Date.parse(job.deadline_at) < Date.now()) throw new Error("Bu işin havuz süresi doldu.");
	await award(db, job, { kind: "partner", id: orgId, amountMinor: job.payout_minor, bidId: null }, actor);
}

/** A partner bids (or changes its bid) on an auction job. */
export async function placeBid(db: Db, job: PoolJob, bidder: { kind: "partner" | "driver"; id: string }, amountMinor: number, note: string | null) {
	if (job.mode !== "auction" || job.status !== "open") throw new Error("Bu ihale kapandı.");
	if (Date.parse(job.deadline_at) < Date.now()) throw new Error("Bu ihalenin süresi doldu.");
	if (!(amountMinor > 0)) throw new Error("Teklif tutarını yazın.");
	if (amountMinor > job.payout_minor) throw new Error("Teklif tavan tutarı geçemez.");
	const now = new Date().toISOString();
	await db
		.insertInto("sd_pool_bids")
		.values({ id: ulid(), pool_job_id: job.id, bidder_kind: bidder.kind, bidder_id: bidder.id, amount_minor: amountMinor, note, status: "active", created_at: now, updated_at: now })
		.onConflict((oc) => oc.columns(["pool_job_id", "bidder_kind", "bidder_id"]).doUpdateSet({ amount_minor: amountMinor, note, status: "active", updated_at: now }))
		.execute();
}

export async function withdrawBid(db: Db, job: PoolJob, bidder: { kind: "partner" | "driver"; id: string }) {
	if (job.status !== "open") throw new Error("Bu ihale kapandı.");
	await db
		.updateTable("sd_pool_bids")
		.set({ status: "withdrawn", updated_at: new Date().toISOString() })
		.where("pool_job_id", "=", job.id)
		.where("bidder_kind", "=", bidder.kind)
		.where("bidder_id", "=", bidder.id)
		.where("status", "=", "active")
		.execute();
}

/** Ops awards an auction to a bid before the deadline. */
export async function awardBid(db: Db, job: PoolJob, bidId: string, actor: Actor) {
	const bid = (await db.selectFrom("sd_pool_bids").selectAll().where("id", "=", bidId).where("pool_job_id", "=", job.id).where("status", "=", "active").executeTakeFirst()) as
		| PoolBid
		| undefined;
	if (!bid) throw new Error("Teklif bulunamadı ya da geri çekilmiş.");
	await award(db, job, { kind: bid.bidder_kind, id: bid.bidder_id, amountMinor: bid.amount_minor, bidId: bid.id }, actor);
}

/** Closes pools whose deadline passed: lowest bid wins; nobody, and ops is told. */
export async function settleDuePools(db: Db, now = Date.now()): Promise<number> {
	const due = (await db
		.selectFrom("sd_pool_jobs")
		.selectAll()
		.where("status", "=", "open")
		.where("deadline_at", "<=", new Date(now).toISOString())
		.limit(10)
		.execute()) as PoolJob[];
	for (const job of due) {
		try {
			const best = (await poolBids(db, job.id)).find((b) => b.status === "active");
			if (job.mode === "auction" && best) {
				await award(db, job, { kind: best.bidder_kind, id: best.bidder_id, amountMinor: best.amount_minor, bidId: best.id }, SYSTEM);
			} else {
				const done = await db
					.updateTable("sd_pool_jobs")
					.set({ status: "expired", closed_at: new Date(now).toISOString() })
					.where("id", "=", job.id)
					.where("status", "=", "open")
					.executeTakeFirst();
				if (Number(done.numUpdatedRows ?? 0) === 1) await addEvent(db, job.booking_id, SYSTEM, "pool_expired", null, null, { mode: job.mode });
			}
		} catch (error) {
			console.error("pool", job.id, error);
		}
	}
	return due.length;
}

let lastRun = 0;
/** Called on private requests; settles deadlines at most once a minute. */
export async function settlePoolsIfDue(db: Db): Promise<void> {
	if (Date.now() - lastRun < 60_000) return;
	lastRun = Date.now();
	try {
		await settleDuePools(db);
	} catch (error) {
		console.error("pool", error);
	}
}

export interface PoolListing {
	pool_id: string;
	mode: PoolMode;
	payout_minor: number;
	deadline_at: string;
	note: string | null;
	code: string;
	pickup_at: string;
	pax: number;
	bags: number;
	flight_no: string | null;
	from_name: string;
	to_name: string;
	class_name: string;
	class_key: string;
	my_bid: number | null;
	my_bid_status: string | null;
	bids: number;
}

/**
 * Open pool jobs as a bidder sees them: the trip, the payout or ceiling, its own bid
 * and how many bid. Never the passenger's details, price or other bidders' amounts.
 */
export async function openPoolFor(db: Db, bidder: { kind: "partner" | "driver"; id: string }): Promise<PoolListing[]> {
	const rows = await db
		.selectFrom("sd_pool_jobs as j")
		.innerJoin("sd_bookings as b", "b.id", "j.booking_id")
		.innerJoin("sd_zones as f", "f.id", "b.from_zone_id")
		.innerJoin("sd_zones as t", "t.id", "b.to_zone_id")
		.innerJoin("sd_vehicle_classes as c", "c.key", "b.class_key")
		.leftJoin("sd_pool_bids as mine", (join) =>
			join.onRef("mine.pool_job_id", "=", "j.id").on("mine.bidder_kind", "=", bidder.kind).on("mine.bidder_id", "=", bidder.id),
		)
		.select((eb) => [
			"j.id as pool_id",
			"j.mode",
			"j.payout_minor",
			"j.deadline_at",
			"j.note",
			"b.code",
			"b.pickup_at",
			"b.pax",
			"b.bags",
			"b.flight_no",
			"f.name as from_name",
			"t.name as to_name",
			"c.name as class_name",
			"c.key as class_key",
			"mine.amount_minor as my_bid",
			"mine.status as my_bid_status",
			eb.selectFrom("sd_pool_bids as x").select(eb.fn.countAll<number>().as("n")).whereRef("x.pool_job_id", "=", "j.id").where("x.status", "=", "active").as("bids"),
		])
		.where("j.status", "=", "open")
		.where("j.deadline_at", ">", new Date().toISOString())
		.orderBy("j.deadline_at")
		.limit(100)
		.execute();
	return rows.map((r) => ({ ...r, bids: Number(r.bids ?? 0) })) as PoolListing[];
}

export async function getOpenPoolByCode(db: Db, code: string): Promise<PoolJob | null> {
	const row = await db
		.selectFrom("sd_pool_jobs as j")
		.innerJoin("sd_bookings as b", "b.id", "j.booking_id")
		.selectAll("j")
		.where("b.code", "=", code)
		.where("j.status", "=", "open")
		.executeTakeFirst();
	return (row as PoolJob | undefined) ?? null;
}
