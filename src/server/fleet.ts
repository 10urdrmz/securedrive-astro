/**
 * Carriers' real cars (sd_fleet_vehicles): the own fleet (ops), partner fleets and
 * drivers each keep theirs. An offer may name one of the bidder's cars; the customer
 * then sees that car's photo and details instead of the class's default ones.
 */
import type { Db } from "./db";
import { ulid } from "./ids";
import { deletePhoto, photoUrl, savePhoto } from "./photos";

export type FleetOwnerKind = "ops" | "partner" | "driver";
export interface FleetOwner {
	kind: FleetOwnerKind;
	id: string;
}
export const OWN_FLEET_OWNER: FleetOwner = { kind: "ops", id: "own" };

export interface FleetVehicle {
	id: string;
	owner_kind: FleetOwnerKind;
	owner_id: string;
	class_key: string;
	model: string;
	year: number | null;
	color: string | null;
	plate: string | null;
	features: string | null;
	photo: string | null;
	status: "active" | "inactive";
	created_at: string;
	updated_at: string;
}

export interface VehicleClassRow {
	key: string;
	name: string;
	pax_max: number;
	bags_max: number;
	sort: number;
	active: number;
	description: string | null;
	features: string | null;
	photo: string | null;
}

/** Features are typed one per line (or comma separated); stored as lines. */
export const featureList = (text: string | null | undefined) =>
	(text ?? "")
		.split(/[\n,]/)
		.map((f) => f.trim())
		.filter(Boolean)
		.slice(0, 20);

/** "Mercedes-Benz Vito 2022 · Siyah" */
export const vehicleLabel = (v: Pick<FleetVehicle, "model" | "year" | "color">) =>
	[[v.model, v.year].filter(Boolean).join(" "), v.color].filter(Boolean).join(" · ");

export { photoUrl };

export async function vehicleClasses(db: Db, activeOnly = false): Promise<VehicleClassRow[]> {
	let query = db.selectFrom("sd_vehicle_classes").selectAll().orderBy("sort").orderBy("pax_max");
	if (activeOnly) query = query.where("active", "=", 1);
	return (await query.execute()) as VehicleClassRow[];
}

export async function ownerVehicles(db: Db, owner: FleetOwner, activeOnly = false): Promise<(FleetVehicle & { class_name: string; pax_max: number; bags_max: number })[]> {
	let query = db
		.selectFrom("sd_fleet_vehicles as v")
		.innerJoin("sd_vehicle_classes as c", "c.key", "v.class_key")
		.selectAll("v")
		.select(["c.name as class_name", "c.pax_max", "c.bags_max"])
		.where("v.owner_kind", "=", owner.kind)
		.where("v.owner_id", "=", owner.id)
		.orderBy("v.status")
		.orderBy("v.created_at");
	if (activeOnly) query = query.where("v.status", "=", "active").where("c.active", "=", 1);
	return (await query.execute()) as (FleetVehicle & { class_name: string; pax_max: number; bags_max: number })[];
}

/** Every carrier's cars with the owner's name, for the ops overview. */
export async function allFleetVehicles(db: Db) {
	return db
		.selectFrom("sd_fleet_vehicles as v")
		.innerJoin("sd_vehicle_classes as c", "c.key", "v.class_key")
		.leftJoin("sd_orgs as o", (join) => join.onRef("o.id", "=", "v.owner_id").on("v.owner_kind", "=", "partner"))
		.leftJoin("sd_drivers as d", (join) => join.onRef("d.id", "=", "v.owner_id").on("v.owner_kind", "=", "driver"))
		.selectAll("v")
		.select(["c.name as class_name", "o.name as org_name", "d.name as driver_name"])
		.orderBy("v.owner_kind")
		.orderBy("v.created_at", "desc")
		.execute() as Promise<(FleetVehicle & { class_name: string; org_name: string | null; driver_name: string | null })[]>;
}

export async function getVehicle(db: Db, id: string): Promise<FleetVehicle | undefined> {
	return (await db.selectFrom("sd_fleet_vehicles").selectAll().where("id", "=", id).executeTakeFirst()) as FleetVehicle | undefined;
}

/**
 * The add, edit, activate and remove-photo actions of a carrier's vehicle form
 * (components/FleetManager.astro). Only the owner's own cars can be changed.
 */
export async function handleFleetForm(db: Db, owner: FleetOwner, form: FormData, opts: { classes?: string[] } = {}): Promise<{ notice?: string; error?: string }> {
	const str = (key: string, max: number) => {
		const value = form.get(key);
		return typeof value === "string" ? value.replace(/[ \t]+/g, " ").trim().slice(0, max) : "";
	};
	const intent = str("fleet_intent", 20);
	if (!intent) return {};
	const id = str("vehicle_id", 40);
	const own = id ? await getVehicle(db, id) : undefined;
	if (id && (!own || own.owner_kind !== owner.kind || own.owner_id !== owner.id)) return { error: "Araç bulunamadı." };

	if (intent === "toggle" && own) {
		const status = own.status === "active" ? "inactive" : "active";
		await db.updateTable("sd_fleet_vehicles").set({ status, updated_at: new Date().toISOString() }).where("id", "=", own.id).execute();
		return { notice: status === "active" ? `${own.model} tekrar tekliflerde kullanılabilir.` : `${own.model} pasif; tekliflerde seçilemez.` };
	}
	if (intent !== "save") return {};

	const classKey = str("class_key", 60);
	const model = str("model", 80);
	const yearText = str("year", 4);
	const year = /^\d{4}$/.test(yearText) && Number(yearText) >= 1990 && Number(yearText) <= new Date().getFullYear() + 1 ? Number(yearText) : null;
	if (!model) return { error: "Araç marka ve modelini yazın." };
	if (yearText && !year) return { error: "Model yılı 4 haneli olmalı (ör. 2022)." };
	const cls = await db.selectFrom("sd_vehicle_classes").select(["key", "active"]).where("key", "=", classKey).executeTakeFirst();
	if (!cls || !cls.active) return { error: "Araç tipini seçin." };
	if (opts.classes && opts.classes.length > 0 && !opts.classes.includes(classKey)) return { error: "Bu araç tipini ekleyemezsiniz." };

	let photo: string | null = null;
	try {
		photo = await savePhoto(form.get("photo"));
	} catch (e) {
		return { error: e instanceof Error ? e.message : "Fotoğraf yüklenemedi." };
	}
	const values = {
		class_key: classKey,
		model,
		year,
		color: str("color", 40) || null,
		plate: str("plate", 16).toUpperCase() || null,
		features: featureList(typeof form.get("features") === "string" ? (form.get("features") as string) : "").join("\n") || null,
		updated_at: new Date().toISOString(),
	};
	if (own) {
		const keepPhoto = form.get("remove_photo") === "on" ? null : own.photo;
		await db
			.updateTable("sd_fleet_vehicles")
			.set({ ...values, photo: photo ?? keepPhoto })
			.where("id", "=", own.id)
			.execute();
		if (own.photo && own.photo !== (photo ?? keepPhoto)) await deletePhoto(own.photo);
		return { notice: `${model} güncellendi.` };
	}
	await db
		.insertInto("sd_fleet_vehicles")
		.values({ id: ulid(), owner_kind: owner.kind, owner_id: owner.id, status: "active", photo, ...values })
		.execute();
	return { notice: `${model} eklendi. Teklif verirken bu aracı seçebilirsiniz.` };
}

/**
 * What a bidder can offer with: its active cars, or when it has none the vehicle
 * classes themselves (the class's default photo then stands in). Values are "v:<id>"
 * for a car and "c:<class>" for a class.
 */
export interface BidOption {
	value: string;
	label: string;
	class_key: string;
	pax_max: number;
	bags_max: number;
}

export async function bidOptions(db: Db, owner: FleetOwner, fallbackClass?: string | null): Promise<BidOption[]> {
	const cars = await ownerVehicles(db, owner, true);
	if (cars.length > 0)
		return cars.map((v) => ({ value: `v:${v.id}`, label: `${vehicleLabel(v)} (${v.class_name})`, class_key: v.class_key, pax_max: v.pax_max, bags_max: v.bags_max }));
	const classes = (await vehicleClasses(db, true)).filter((c) => !fallbackClass || c.key === fallbackClass);
	return classes.map((c) => ({ value: `c:${c.key}`, label: `${c.name} (${c.pax_max} kişi)`, class_key: c.key, pax_max: c.pax_max, bags_max: c.bags_max }));
}

/** The class and car an offer form names, checked against the bidder's own cars. */
export async function readBidOption(db: Db, owner: FleetOwner, value: string): Promise<{ classKey: string; vehicleId: string | null; vehicle: string | null }> {
	if (value.startsWith("v:")) {
		const car = await getVehicle(db, value.slice(2));
		if (!car || car.owner_kind !== owner.kind || car.owner_id !== owner.id || car.status !== "active") throw new Error("Aracı seçin.");
		return { classKey: car.class_key, vehicleId: car.id, vehicle: vehicleLabel(car) };
	}
	if (value.startsWith("c:")) return { classKey: value.slice(2), vehicleId: null, vehicle: null };
	throw new Error("Aracı seçin.");
}
