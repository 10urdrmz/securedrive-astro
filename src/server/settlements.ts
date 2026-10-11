/**
 * Hakediş (Faz 5.2): what we owe drivers and partner fleets for completed trips, net of
 * the cash their drivers collected from passengers, in weekly statements.
 *
 * Every completed booking belongs to exactly one party: the partner fleet it was given
 * to, otherwise the driver who drove it. A statement ("döküm") freezes that party's
 * unsettled trips up to the end of a week (earlier weeks that were missed carry over),
 * and finance marks it paid once the money moved. Net > 0: we pay them; net < 0: they
 * hand cash over to us.
 *
 * Cash: a completed booking paid "Araçta nakit" means the driver kept the passenger's
 * money (the booking price). Card in the vehicle goes through our POS, so it is not
 * the driver's to hand over.
 */
import { sql } from "kysely";
import type { Db } from "./db";
import { ulid } from "./ids";

export type PartyKind = "driver" | "partner";
export type SettlementStatus = "open" | "paid" | "void";

export const SETTLEMENT_LABELS: Record<SettlementStatus, string> = { open: "Açık", paid: "Kapandı", void: "Geri alındı" };

export interface SettlementLine {
	booking_id: string;
	code: string;
	pickup_at: string;
	from_name: string;
	to_name: string;
	payment_method: string;
	price_minor: number;
	payout_minor: number | null;
	cash_minor: number;
	driver_id: string | null;
	driver_name: string | null;
	carrier_org_id: string | null;
}

export interface PartyBalance {
	kind: PartyKind;
	id: string;
	name: string;
	lines: SettlementLine[];
	jobs: number;
	payout: number;
	cash: number;
	net: number;
	/** Trips with no payout amount on them; ops should fill these in before paying. */
	missingPayout: number;
}

export interface Settlement {
	id: string;
	party_kind: PartyKind;
	party_id: string;
	party_name: string;
	period_start: string;
	period_end: string;
	jobs: number;
	payout_minor: number;
	cash_minor: number;
	net_minor: number;
	status: SettlementStatus;
	created_at: string;
	paid_at: string | null;
	paid_note: string | null;
}

const IST = 3 * 3600_000;
const WEEK = 7 * 24 * 3600_000;

/** A Monday–Sunday week in Istanbul time; offset 0 is this week, -1 last week. */
export function istanbulWeek(offset = 0, now = Date.now()) {
	const local = new Date(now + IST);
	const day = (local.getUTCDay() + 6) % 7; // Monday = 0
	const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day) + offset * WEEK;
	const start = new Date(mondayLocal - IST).toISOString();
	const end = new Date(mondayLocal + WEEK - IST).toISOString();
	return { start, end, label: weekLabel(start, end) };
}

/** "6 – 12 Ekim 2026" for a period stored as UTC instants. */
export function weekLabel(start: string, end: string) {
	const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("tr-TR", { ...opts, timeZone: "Europe/Istanbul" }).format(new Date(iso));
	const last = new Date(Date.parse(end) - 1).toISOString();
	const sameMonth = fmt(start, { month: "long" }) === fmt(last, { month: "long" });
	return `${fmt(start, sameMonth ? { day: "numeric" } : { day: "numeric", month: "long" })} – ${fmt(last, { day: "numeric", month: "long", year: "numeric" })}`;
}

function baseQuery(db: Db) {
	return db
		.selectFrom("sd_bookings as b")
		.innerJoin("sd_zones as f", "f.id", "b.from_zone_id")
		.innerJoin("sd_zones as t", "t.id", "b.to_zone_id")
		.leftJoin("sd_drivers as d", "d.id", "b.driver_id")
		.leftJoin("sd_carrier_jobs as j", (join) => join.onRef("j.booking_id", "=", "b.id").on("j.status", "=", "accepted"))
		.select([
			"b.id as booking_id",
			"b.code",
			"b.pickup_at",
			"f.name as from_name",
			"t.name as to_name",
			"b.payment_method",
			"b.price_minor",
			sql<number | null>`case when b.carrier_org_id is not null then j.payout_minor else b.payout_minor end`.as("payout_minor"),
			sql<number>`case when b.payment_method = 'cash' then b.price_minor else 0 end`.as("cash_minor"),
			"b.driver_id",
			"d.name as driver_name",
			"b.carrier_org_id",
		])
		.where("b.status", "=", "completed");
}

/** Completed trips not on any statement yet, up to `before` (exclusive). */
export async function unsettledLines(db: Db, before: string): Promise<SettlementLine[]> {
	return (await baseQuery(db)
		.where("b.settlement_id", "is", null)
		.where("b.pickup_at", "<", before)
		.where((eb) => eb.or([eb("b.carrier_org_id", "is not", null), eb("b.driver_id", "is not", null)]))
		.orderBy("b.pickup_at")
		.execute()) as SettlementLine[];
}

export async function settlementLines(db: Db, settlementId: string): Promise<SettlementLine[]> {
	return (await baseQuery(db).where("b.settlement_id", "=", settlementId).orderBy("b.pickup_at").execute()) as SettlementLine[];
}

const partyOf = (line: SettlementLine): { kind: PartyKind; id: string } =>
	line.carrier_org_id ? { kind: "partner", id: line.carrier_org_id } : { kind: "driver", id: line.driver_id! };

/** Unsettled trips grouped by who is owed, partners first, then by name. */
export async function balances(db: Db, before: string): Promise<PartyBalance[]> {
	const lines = await unsettledLines(db, before);
	const orgIds = [...new Set(lines.flatMap((l) => (l.carrier_org_id ? [l.carrier_org_id] : [])))];
	const orgNames = new Map(
		orgIds.length ? (await db.selectFrom("sd_orgs").select(["id", "name"]).where("id", "in", orgIds).execute()).map((o) => [o.id as string, o.name as string]) : [],
	);
	const groups = new Map<string, PartyBalance>();
	for (const line of lines) {
		const { kind, id } = partyOf(line);
		const key = `${kind}:${id}`;
		const group = groups.get(key) ?? {
			kind,
			id,
			name: kind === "partner" ? (orgNames.get(id) ?? "Partner") : (line.driver_name ?? "Sürücü"),
			lines: [],
			jobs: 0,
			payout: 0,
			cash: 0,
			net: 0,
			missingPayout: 0,
		};
		group.lines.push(line);
		group.jobs++;
		group.payout += line.payout_minor ?? 0;
		group.cash += line.cash_minor;
		group.net = group.payout - group.cash;
		if (line.payout_minor == null) group.missingPayout++;
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "tr") : a.kind === "partner" ? -1 : 1));
}

/** Freezes one party's unsettled trips up to the period end into a statement. */
export async function createSettlement(db: Db, party: { kind: PartyKind; id: string }, period: { start: string; end: string }, userId: string | null) {
	const balance = (await balances(db, period.end)).find((b) => b.kind === party.kind && b.id === party.id);
	if (!balance) throw new Error("Bu dönem için hakediş bekleyen iş yok.");
	const id = ulid();
	await db
		.insertInto("sd_settlements")
		.values({
			id,
			party_kind: balance.kind,
			party_id: balance.id,
			party_name: balance.name,
			period_start: period.start,
			period_end: period.end,
			jobs: balance.jobs,
			payout_minor: balance.payout,
			cash_minor: balance.cash,
			net_minor: balance.net,
			status: "open",
			created_by: userId,
		})
		.execute();
	await db
		.updateTable("sd_bookings")
		.set({ settlement_id: id })
		.where(
			"id",
			"in",
			balance.lines.map((l) => l.booking_id),
		)
		.where("settlement_id", "is", null)
		.execute();
	return { id, balance };
}

export async function getSettlement(db: Db, id: string): Promise<Settlement | null> {
	return ((await db.selectFrom("sd_settlements").selectAll().where("id", "=", id).executeTakeFirst()) as Settlement | undefined) ?? null;
}

export async function markPaid(db: Db, settlement: Settlement, userId: string | null, note: string | null) {
	if (settlement.status !== "open") throw new Error("Bu döküm zaten kapanmış.");
	await db
		.updateTable("sd_settlements")
		.set({ status: "paid", paid_at: new Date().toISOString(), paid_by: userId, paid_note: note })
		.where("id", "=", settlement.id)
		.where("status", "=", "open")
		.execute();
}

/** Undoes an unpaid statement: its trips go back to the unsettled list. */
export async function voidSettlement(db: Db, settlement: Settlement) {
	if (settlement.status !== "open") throw new Error("Ödenmiş bir döküm geri alınamaz.");
	await db.updateTable("sd_settlements").set({ status: "void" }).where("id", "=", settlement.id).where("status", "=", "open").execute();
	await db.updateTable("sd_bookings").set({ settlement_id: null }).where("settlement_id", "=", settlement.id).execute();
}

export async function listSettlements(db: Db, filter: { kind?: PartyKind; partyId?: string; limit?: number } = {}): Promise<Settlement[]> {
	let query = db.selectFrom("sd_settlements").selectAll().where("status", "!=", "void");
	if (filter.kind) query = query.where("party_kind", "=", filter.kind);
	if (filter.partyId) query = query.where("party_id", "=", filter.partyId);
	return (await query.orderBy("created_at", "desc").limit(filter.limit ?? 50).execute()) as Settlement[];
}

/** Running balance of a party: unsettled trips so far plus statements not yet paid. */
export async function partySummary(db: Db, kind: PartyKind, id: string) {
	const current = (await balances(db, new Date(Date.now() + WEEK).toISOString())).find((b) => b.kind === kind && b.id === id) ?? null;
	const statements = await listSettlements(db, { kind, partyId: id, limit: 26 });
	return { current, statements };
}
