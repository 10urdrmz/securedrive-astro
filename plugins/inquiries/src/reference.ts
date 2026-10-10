/**
 * Request numbers, e.g. "SD-2610-0042": the year and month the request arrived
 * (Istanbul time) and its place in that month's sequence. Customers quote it on
 * the phone; the operations team searches by it.
 *
 * The number is stored on the entry (the "Talep no" field). Each month has its
 * own counter row in `sd_counters`, bumped in a single statement so two requests
 * arriving together can never get the same number.
 */
import { getDb } from "emdash/runtime";

let ready: Promise<void> | undefined;

/** "2610" for October 2026, in the company's own time zone. */
function period(now: Date): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "2-digit", month: "2-digit" }).formatToParts(now);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
	return `${part("year")}${part("month")}`;
}

/** Take the next request number of the current month. */
export async function nextReference(now = new Date()): Promise<string> {
	// The counter table is not part of EmDash's typed schema.
	const db: any = await getDb();
	ready ??= db.schema
		.createTable("sd_counters")
		.ifNotExists()
		.addColumn("key", "text", (c: any) => c.primaryKey())
		.addColumn("value", "integer", (c: any) => c.notNull())
		.execute()
		.catch((error: unknown) => {
			ready = undefined;
			throw error;
		});
	await ready;

	const yymm = period(now);
	const row = await db
		.insertInto("sd_counters")
		.values({ key: `inquiries:${yymm}`, value: 1 })
		.onConflict((oc: any) => oc.column("key").doUpdateSet((eb: any) => ({ value: eb("value", "+", 1) })))
		.returning("value")
		.executeTakeFirstOrThrow();
	return `SD-${yymm}-${String(row.value).padStart(4, "0")}`;
}

/**
 * The number to show for an entry: the stored one, or for an entry that somehow
 * has none, a stable stand-in built from the random tail of its id.
 */
export function inquiryReference(id: string, stored?: unknown): string {
	return typeof stored === "string" && stored ? stored : `SD-${id.slice(-8).toUpperCase()}`;
}
