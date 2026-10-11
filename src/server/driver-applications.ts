/**
 * Independent drivers (Faz 6.2): drivers with their own licensed vehicle apply on
 * /surucu/basvuru; ops checks their papers and approves them into sd_drivers as
 * kind "independent" with a PIN for the driver app. They take work from the job pool
 * (fixed jobs, auctions) rather than through automatic dispatch, and are paid like our
 * own drivers: weekly statements at /surucu/kazanc.
 */
import type { Db } from "./db";
import { ulid } from "./ids";
import { issuePin, phoneKey } from "./driver-app";

export interface DriverApplication {
	id: string;
	name: string;
	phone: string;
	phone_key: string;
	class_key: string | null;
	plate: string | null;
	vehicle: string | null;
	languages: string;
	licence: string | null;
	note: string | null;
	status: "pending" | "approved" | "rejected";
	driver_id: string | null;
	reviewed_at: string | null;
	review_note: string | null;
	created_at: string;
}

export interface ApplicationInput {
	name: string;
	phone: string;
	classKey: string | null;
	plate: string | null;
	vehicle: string | null;
	languages: string;
	licence: string | null;
	note: string | null;
}

/** Stores an application. One open application per phone; a known driver is sent to sign in. */
export async function submitApplication(db: Db, input: ApplicationInput): Promise<"ok" | "pending" | "driver"> {
	const key = phoneKey(input.phone);
	const drivers = await db.selectFrom("sd_drivers").select("phone").execute();
	if (drivers.some((d: { phone: string }) => phoneKey(d.phone) === key)) return "driver";
	const open = await db.selectFrom("sd_driver_applications").select("id").where("phone_key", "=", key).where("status", "=", "pending").executeTakeFirst();
	if (open) return "pending";
	await db
		.insertInto("sd_driver_applications")
		.values({
			id: ulid(),
			name: input.name,
			phone: input.phone,
			phone_key: key,
			class_key: input.classKey,
			plate: input.plate,
			vehicle: input.vehicle,
			languages: input.languages,
			licence: input.licence,
			note: input.note,
			status: "pending",
		})
		.execute();
	return "ok";
}

export async function listApplications(db: Db, status: DriverApplication["status"] = "pending"): Promise<DriverApplication[]> {
	return (await db
		.selectFrom("sd_driver_applications")
		.selectAll()
		.where("status", "=", status)
		.orderBy("created_at", status === "pending" ? "asc" : "desc")
		.limit(100)
		.execute()) as DriverApplication[];
}

export async function countPendingApplications(db: Db): Promise<number> {
	const row = await db
		.selectFrom("sd_driver_applications")
		.select((eb) => eb.fn.countAll<number>().as("n"))
		.where("status", "=", "pending")
		.executeTakeFirst();
	return Number(row?.n ?? 0);
}

async function pending(db: Db, id: string): Promise<DriverApplication> {
	const row = (await db.selectFrom("sd_driver_applications").selectAll().where("id", "=", id).executeTakeFirst()) as DriverApplication | undefined;
	if (!row) throw new Error("Başvuru bulunamadı.");
	if (row.status !== "pending") throw new Error("Bu başvuru zaten sonuçlandı.");
	return row;
}

/** Turns an application into an active independent driver and returns the PIN to pass on. */
export async function approveApplication(
	db: Db,
	id: string,
	reviewer: string,
	edits: { classKey: string | null; plate: string | null; vehicle: string | null },
): Promise<{ driverId: string; name: string; phone: string; pin: string }> {
	const app = await pending(db, id);
	const driverId = ulid();
	const now = new Date().toISOString();
	const claimed = await db
		.updateTable("sd_driver_applications")
		.set({ status: "approved", driver_id: driverId, reviewed_by: reviewer, reviewed_at: now })
		.where("id", "=", id)
		.where("status", "=", "pending")
		.executeTakeFirst();
	if (Number(claimed.numUpdatedRows ?? 0) !== 1) throw new Error("Bu başvuru zaten sonuçlandı.");
	await db
		.insertInto("sd_drivers")
		.values({
			id: driverId,
			name: app.name,
			phone: app.phone,
			kind: "independent",
			class_key: edits.classKey ?? app.class_key,
			plate: edits.plate ?? app.plate,
			vehicle: edits.vehicle ?? app.vehicle,
			languages: app.languages,
			status: "active",
			notes: [app.licence && `Belge: ${app.licence}`, app.note].filter(Boolean).join(" · ") || null,
		})
		.execute();
	const pin = await issuePin(db, driverId);
	return { driverId, name: app.name, phone: app.phone, pin };
}

export async function rejectApplication(db: Db, id: string, reviewer: string, note: string | null) {
	await pending(db, id);
	await db
		.updateTable("sd_driver_applications")
		.set({ status: "rejected", reviewed_by: reviewer, reviewed_at: new Date().toISOString(), review_note: note })
		.where("id", "=", id)
		.where("status", "=", "pending")
		.execute();
}
