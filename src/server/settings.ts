/**
 * Business rules edited from /ops/yonetim/ayarlar. Stored as JSON in sd_settings;
 * code reads them through getSettings() so a missing key always falls back to a default.
 */
import type { Db } from "./db";

export interface BusinessSettings {
	/** Surcharge for pickups inside the night window, in percent. */
	nightSurchargePct: number;
	nightStart: string; // "00:00"
	nightEnd: string; // "06:00"
	/** Surcharge when the pickup is closer than `lastMinuteHours`, in percent. */
	lastMinutePct: number;
	lastMinuteHours: number;
	/** Discount on the return leg of a round trip, in percent. */
	roundTripDiscountPct: number;
	/** Bookings closer than this are refused online (call us instead). */
	minLeadHours: number;
	/** Free waiting, in minutes. */
	freeWaitInternationalMin: number;
	freeWaitDomesticMin: number;
	freeWaitAddressMin: number;
	/** Refund share by hours before pickup, checked top to bottom. */
	cancellation: { hoursBefore: number; refundPct: number }[];
	/** Offer unassigned bookings to drivers one by one, without ops. */
	autoAssign: boolean;
	/** Start offering this many hours before pickup. */
	autoAssignHours: number;
	/** A driver who has not answered an automatic offer within this loses it. */
	offerMinutes: number;
}

export const DEFAULT_SETTINGS: BusinessSettings = {
	nightSurchargePct: 0,
	nightStart: "00:00",
	nightEnd: "06:00",
	lastMinutePct: 0,
	lastMinuteHours: 6,
	roundTripDiscountPct: 0,
	minLeadHours: 2,
	freeWaitInternationalMin: 60,
	freeWaitDomesticMin: 45,
	freeWaitAddressMin: 15,
	cancellation: [
		{ hoursBefore: 12, refundPct: 100 },
		{ hoursBefore: 3, refundPct: 50 },
		{ hoursBefore: 0, refundPct: 0 },
	],
	autoAssign: true,
	autoAssignHours: 24,
	offerMinutes: 15,
};

const KEY = "business";

export async function getSettings(db: Db): Promise<BusinessSettings> {
	const row = await db.selectFrom("sd_settings").select("value").where("key", "=", KEY).executeTakeFirst();
	if (!row) return DEFAULT_SETTINGS;
	try {
		return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<BusinessSettings>) };
	} catch {
		return DEFAULT_SETTINGS;
	}
}

export async function saveSettings(db: Db, settings: BusinessSettings, userId: string) {
	const value = JSON.stringify(settings);
	const updated_at = new Date().toISOString();
	await db
		.insertInto("sd_settings")
		.values({ key: KEY, value, updated_by: userId, updated_at })
		.onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_by: userId, updated_at }))
		.execute();
}
