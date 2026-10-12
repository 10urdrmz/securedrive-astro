/**
 * Price offers on customer requests (the GetTransfer model, chosen by Onur on 2026-10-12).
 *
 * A public booking starts as a request: a booking in status "bidding" with no price.
 * Partner fleets, approved independent drivers and ops (for the own fleet) each send
 * one price; the customer sees them side by side and picks one. The pick turns the
 * request into a confirmed booking at that price and hands it to the winner, the same
 * way a won pool job is handed over (pool.ts handToCarrier).
 *
 * Carriers offer what they want to earn; the customer sees that plus the platform
 * commission from Kurallar. Ops offers for the own fleet enter the customer price.
 * Bidders never see the passenger's name, phone, e-mail or other bidders' amounts.
 */
import { sql } from "kysely";
import type { Db } from "./db";
import {
  addEvent,
  ConflictError,
  getBookingByCode,
  nextBookingCode,
  transition,
  updateBooking,
  type Actor,
  type Booking,
  type PaymentMethod,
} from "./bookings";
import { handToCarrier } from "./pool";
import { getSettings } from "./settings";
import { istanbulToIso } from "./pricing";
import { randomToken, ulid } from "./ids";
import { maskContacts } from "./messages";
import { getCompany } from "./companies";
import { getAgency } from "./agencies";

export type OfferBidderKind = "partner" | "driver" | "ops";
export interface OfferBidder {
  kind: OfferBidderKind;
  id: string;
}

export interface Offer {
  id: string;
  booking_id: string;
  bidder_kind: OfferBidderKind;
  bidder_id: string;
  class_key: string;
  payout_minor: number;
  price_minor: number;
  vehicle: string | null;
  note: string | null;
  status: "active" | "withdrawn" | "won" | "lost";
  created_at: string;
  updated_at: string;
}

/** Offers close, and an unpicked request is cancelled, this long before pickup. */
export const CLOSE_BEFORE_MS = 60 * 60_000;

const SYSTEM: Actor = { kind: "system", userId: null };
/** Prices the customer sees end in a round 10 TL. */
const roundUp = (minor: number) => Math.ceil(minor / 1000) * 1000;

export async function customerPrice(
  db: Db,
  payoutMinor: number,
): Promise<number> {
  const { offerCommissionPct } = await getSettings(db);
  return roundUp(payoutMinor * (1 + offerCommissionPct / 100));
}

export interface NewRequest {
  fromZoneId: string;
  toZoneId: string;
  date: string;
  time: string;
  pax: number;
  bags: number;
  contact: { name: string; phone: string; email: string | null };
  flightNo: string | null;
  signName: string | null;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  notes: string | null;
  paymentMethod: PaymentMethod;
  locale: string;
  memberId: string | null;
  agencyId: string | null;
  /** Extras the customer asked for (child seat …), shown to bidders and added to the price. */
  extras: Record<string, number>;
  /** Company and agency panels and ops phone bookings post requests too. */
  source?: "web" | "company" | "agency" | "ops";
  orgId?: string | null;
  costCenter?: string | null;
  internalNotes?: string | null;
  actor?: Actor;
}

export type RequestError =
  "invalidInput" | "notServiceable" | "tooSoon" | "past" | "tooMany";

/** The customer posts a trip. It waits as a "bidding" booking until an offer is picked. */
export async function createRequest(
  db: Db,
  input: NewRequest,
): Promise<
  { ok: true; booking: Booking } | { ok: false; error: RequestError }
> {
  const pickupAt = istanbulToIso(input.date, input.time);
  if (
    !pickupAt ||
    input.fromZoneId === input.toZoneId ||
    input.pax < 1 ||
    input.pax > 60 ||
    input.bags < 0 ||
    input.bags > 60
  )
    return { ok: false, error: "invalidInput" };
  const settings = await getSettings(db);
  const hoursAhead = (Date.parse(pickupAt) - Date.now()) / 3600_000;
  if (hoursAhead < 0) return { ok: false, error: "past" };
  if (hoursAhead < settings.minLeadHours)
    return { ok: false, error: "tooSoon" };
  const zones = await db
    .selectFrom("sd_zones")
    .select(["id", "serviceable"])
    .where("id", "in", [input.fromZoneId, input.toZoneId])
    .execute();
  if (zones.length !== 2) return { ok: false, error: "invalidInput" };
  if (zones.some((z) => !z.serviceable))
    return { ok: false, error: "notServiceable" };
  // The smallest class that fits stands in until an offer names the real one.
  const fitting = await db
    .selectFrom("sd_vehicle_classes")
    .select("key")
    .where("active", "=", 1)
    .where("pax_max", ">=", input.pax)
    .where("bags_max", ">=", input.bags)
    .orderBy("pax_max")
    .orderBy("sort")
    .executeTakeFirst();
  if (!fitting) return { ok: false, error: "tooMany" };

  const extrasCatalog = await db
    .selectFrom("sd_extras")
    .select(["key", "name", "price_minor", "max_qty"])
    .where("active", "=", 1)
    .execute();
  const extras = extrasCatalog
    .map((e) => ({
      ...e,
      qty: Math.min(
        Math.max(Math.floor(input.extras[e.key] ?? 0), 0),
        e.max_qty,
      ),
    }))
    .filter((e) => e.qty > 0);

  const id = ulid();
  const now = new Date().toISOString();
  const row = {
    id,
    code: await nextBookingCode(db),
    status: "bidding",
    version: 1,
    source: input.source ?? "web",
    locale: input.locale,
    customer_member_id: input.memberId,
    org_id: input.orgId ?? "",
    cost_center: input.costCenter ?? null,
    agency_id: input.agencyId,
    from_zone_id: input.fromZoneId,
    to_zone_id: input.toZoneId,
    pickup_address: input.pickupAddress,
    dropoff_address: input.dropoffAddress,
    pickup_at: pickupAt,
    flight_no: input.flightNo,
    pax: input.pax,
    bags: input.bags,
    class_key: fitting.key,
    contact_name: input.contact.name,
    contact_phone: input.contact.phone,
    contact_email: input.contact.email,
    sign_name: input.signName,
    notes: input.notes,
    internal_notes: input.internalNotes ?? null,
    price_minor: 0,
    currency: "TRY",
    breakdown: "[]",
    payout_minor: null,
    payment_method: input.paymentMethod,
    payment_status: "unpaid",
    tracking_token: randomToken(18),
    created_by: input.actor?.userId ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto("sd_bookings").values(row).execute();
  for (const e of extras) {
    await db
      .insertInto("sd_booking_extras")
      .values({
        booking_id: id,
        extra_key: e.key,
        name: e.name,
        qty: e.qty,
        price_minor: e.price_minor * e.qty,
      })
      .execute();
  }
  await addEvent(
    db,
    id,
    input.actor ?? { kind: "passenger" },
    "created",
    null,
    "bidding",
    { source: input.source ?? "web", request: true },
  );
  return { ok: true, booking: (await getBookingByCode(db, row.code))! };
}

/** What the customer pays on top of the offer: the extras they asked for. */
async function extrasOf(db: Db, bookingId: string) {
  return db
    .selectFrom("sd_booking_extras")
    .select(["extra_key", "name", "qty", "price_minor"])
    .where("booking_id", "=", bookingId)
    .execute();
}

/**
 * What a business buyer gets on a request: a company's contract discount and allowed
 * classes, or an agency's net discount when it pays on account. Discounts come out of
 * the platform's margin, never the carrier's amount.
 */
export async function buyerTerms(
  db: Db,
  booking: Pick<Booking, "org_id" | "agency_id" | "payment_method">,
): Promise<{ discountPct: number; classes: string[] }> {
  if (booking.org_id) {
    const company = await getCompany(db, booking.org_id);
    if (company)
      return {
        discountPct: company.settings.discountPct,
        classes: company.settings.classes,
      };
  }
  if (booking.agency_id && booking.payment_method === "account") {
    const agency = await getAgency(db, booking.agency_id);
    if (agency)
      return { discountPct: agency.settings.discountPct, classes: [] };
  }
  return { discountPct: 0, classes: [] };
}

/** The buyer's price for an offer after its discount, never below what the carrier gets. */
export function buyerPrice(
  offer: Pick<Offer, "price_minor" | "payout_minor">,
  discountPct: number,
): number {
  if (!discountPct) return offer.price_minor;
  return Math.max(
    offer.payout_minor,
    offer.price_minor - Math.round((offer.price_minor * discountPct) / 100),
  );
}

/** Why this bidder may not offer on this request, or null. */
async function offerProblem(
  db: Db,
  booking: Booking,
  bidder: OfferBidder,
  classKey: string,
): Promise<string | null> {
  if (booking.status !== "bidding")
    return "Müşteri bu talep için zaten bir teklif seçti ya da talep kapandı.";
  if (Date.parse(booking.pickup_at) - Date.now() < CLOSE_BEFORE_MS)
    return "Bu talebe teklif süresi doldu.";
  const vehicleClass = await db
    .selectFrom("sd_vehicle_classes")
    .select(["pax_max", "bags_max", "active"])
    .where("key", "=", classKey)
    .executeTakeFirst();
  if (!vehicleClass || !vehicleClass.active) return "Araç sınıfını seçin.";
  if (
    booking.pax > vehicleClass.pax_max ||
    booking.bags > vehicleClass.bags_max
  )
    return "Bu araç sınıfı yolcu ve bavul sayısına yetmiyor.";
  const { classes } = await buyerTerms(db, booking);
  if (classes.length > 0 && !classes.includes(classKey))
    return "Bu kurumsal müşteri sözleşmesinde bu araç sınıfı yok.";
  if (bidder.kind === "partner") {
    const partner = await db
      .selectFrom("sd_orgs")
      .select(["kind", "status"])
      .where("id", "=", bidder.id)
      .executeTakeFirst();
    return partner?.kind === "carrier" && partner.status === "active"
      ? null
      : "Partner hesabınız aktif değil.";
  }
  if (bidder.kind === "driver") {
    const driver = await db
      .selectFrom("sd_drivers")
      .select(["kind", "status", "org_id", "class_key"])
      .where("id", "=", bidder.id)
      .executeTakeFirst();
    if (
      !driver ||
      driver.kind !== "independent" ||
      driver.org_id ||
      driver.status !== "active"
    )
      return "Teklif vermek yalnızca onaylı bağımsız sürücülere açık.";
    if (driver.class_key && driver.class_key !== classKey)
      return "Yalnızca kendi araç sınıfınızla teklif verebilirsiniz.";
    const pickup = Date.parse(booking.pickup_at);
    const clash = await db
      .selectFrom("sd_bookings")
      .select("code")
      .where("driver_id", "=", bidder.id)
      .where("status", "not in", ["cancelled", "completed", "no_show"])
      .where("pickup_at", ">", new Date(pickup - 3 * 3600_000).toISOString())
      .where("pickup_at", "<", new Date(pickup + 3 * 3600_000).toISOString())
      .executeTakeFirst();
    if (clash) return `Bu saatlere yakın başka bir işiniz var (${clash.code}).`;
  }
  return null;
}

/**
 * A bidder sends or changes its offer. Carriers give what they want to earn; ops gives
 * the customer price for the own fleet (payout then decided at assignment as usual).
 */
export async function placeOffer(
  db: Db,
  booking: Booking,
  bidder: OfferBidder,
  input: {
    classKey: string;
    amountMinor: number;
    vehicle: string | null;
    note: string | null;
  },
) {
  if (!(input.amountMinor >= 10_000))
    throw new Error("Tutarı yazın. Örnek: 1.650");
  const problem = await offerProblem(db, booking, bidder, input.classKey);
  if (problem) throw new Error(problem);
  const own = bidder.kind === "ops";
  const payout = own ? 0 : input.amountMinor;
  const price = own
    ? input.amountMinor
    : await customerPrice(db, input.amountMinor);
  const now = new Date().toISOString();
  const values = {
    class_key: input.classKey,
    payout_minor: payout,
    price_minor: price,
    vehicle: input.vehicle,
    note: input.note,
    status: "active",
    updated_at: now,
  };
  await db
    .insertInto("sd_offers")
    .values({
      id: ulid(),
      booking_id: booking.id,
      bidder_kind: bidder.kind,
      bidder_id: bidder.id,
      created_at: now,
      ...values,
    })
    .onConflict((oc) =>
      oc
        .columns(["booking_id", "bidder_kind", "bidder_id"])
        .doUpdateSet(values),
    )
    .execute();
  await addEvent(
    db,
    booking.id,
    {
      kind: own ? "ops" : bidder.kind === "partner" ? "partner" : "driver",
      userId: null,
    },
    "offer_received",
    null,
    null,
    {
      bidder: bidder.kind,
      price_minor: price,
    },
  );
}

export async function withdrawOffer(
  db: Db,
  booking: Booking,
  bidder: OfferBidder,
) {
  await db
    .updateTable("sd_offers")
    .set({ status: "withdrawn", updated_at: new Date().toISOString() })
    .where("booking_id", "=", booking.id)
    .where("bidder_kind", "=", bidder.kind)
    .where("bidder_id", "=", bidder.id)
    .where("status", "=", "active")
    .execute();
}

export interface OfferCard extends Offer {
  /** What the customer sees: the fleet's name, or a driver's first name and initial. */
  display_name: string;
  /** The offer before a business buyer's discount; price_minor is what this buyer pays. */
  list_price_minor: number;
  class_name: string;
  pax_max: number;
  bags_max: number;
  rating: number | null;
  ratings: number;
  trips: number;
}

const shortName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0]!.toLocaleUpperCase("tr-TR")}.` : first!;
};

/** The live offers on a request, cheapest first, with each bidder's track record. */
export async function offersFor(
  db: Db,
  booking: Booking,
  statuses: Offer["status"][] = ["active"],
): Promise<OfferCard[]> {
  const rows = (await db
    .selectFrom("sd_offers as o")
    .innerJoin("sd_vehicle_classes as c", "c.key", "o.class_key")
    .leftJoin("sd_orgs as p", (join) =>
      join
        .onRef("p.id", "=", "o.bidder_id")
        .on("o.bidder_kind", "=", "partner"),
    )
    .leftJoin("sd_drivers as d", (join) =>
      join.onRef("d.id", "=", "o.bidder_id").on("o.bidder_kind", "=", "driver"),
    )
    .selectAll("o")
    .select([
      "c.name as class_name",
      "c.pax_max",
      "c.bags_max",
      "p.name as partner_name",
      "d.name as driver_name",
    ])
    .where("o.booking_id", "=", booking.id)
    .where("o.status", "in", statuses)
    .orderBy("o.price_minor")
    .orderBy("o.updated_at")
    .execute()) as (Offer & {
    class_name: string;
    pax_max: number;
    bags_max: number;
    partner_name: string | null;
    driver_name: string | null;
  })[];
  const terms = await buyerTerms(db, booking);
  const cards: OfferCard[] = [];
  for (const r of rows) {
    if (terms.classes.length > 0 && !terms.classes.includes(r.class_key))
      continue;
    // Track record: completed trips and passenger ratings of this fleet or driver.
    const scope =
      r.bidder_kind === "partner"
        ? sql<boolean>`b.carrier_org_id = ${r.bidder_id}`
        : r.bidder_kind === "driver"
          ? sql<boolean>`b.driver_id = ${r.bidder_id}`
          : sql<boolean>`b.carrier_org_id is null and b.driver_id in (select id from sd_drivers where kind = 'staff')`;
    const stats = await db
      .selectFrom("sd_bookings as b")
      .leftJoin("sd_reviews as r", "r.booking_id", "b.id")
      .select((eb) => [
        eb.fn.countAll<number>().as("trips"),
        eb.fn.count<number>("r.rating").as("ratings"),
        eb.fn.avg<number>("r.rating").as("rating"),
      ])
      .where("b.status", "=", "completed")
      .where(scope)
      .executeTakeFirst();
    cards.push({
      ...r,
      price_minor: buyerPrice(r, terms.discountPct),
      list_price_minor: r.price_minor,
      vehicle: r.vehicle && maskContacts(r.vehicle),
      note: r.note && maskContacts(r.note),
      display_name:
        r.bidder_kind === "partner"
          ? (r.partner_name ?? "Partner")
          : r.bidder_kind === "driver"
            ? shortName(r.driver_name ?? "Sürücü")
            : "SecureDrive",
      rating: stats?.rating ? Math.round(Number(stats.rating) * 10) / 10 : null,
      ratings: Number(stats?.ratings ?? 0),
      trips: Number(stats?.trips ?? 0),
    });
  }
  return cards;
}

/**
 * The customer (or ops for them, on the phone) picks an offer: the request becomes a
 * confirmed booking at that price and goes to the winner. The version check on the
 * booking makes sure only one pick ever wins.
 */
export async function pickOffer(
  db: Db,
  booking: Booking,
  offerId: string,
  actor: Actor,
): Promise<Booking> {
  if (booking.status !== "bidding") throw new Error("closed");
  const offer = (await db
    .selectFrom("sd_offers")
    .selectAll()
    .where("id", "=", offerId)
    .where("booking_id", "=", booking.id)
    .where("status", "=", "active")
    .executeTakeFirst()) as Offer | undefined;
  if (!offer) throw new Error("gone");
  if (
    offer.bidder_kind !== "ops" &&
    (await offerProblem(
      db,
      booking,
      { kind: offer.bidder_kind, id: offer.bidder_id },
      offer.class_key,
    ))
  )
    throw new Error("gone");
  const vehicleClass = await db
    .selectFrom("sd_vehicle_classes")
    .select("name")
    .where("key", "=", offer.class_key)
    .executeTakeFirstOrThrow();
  const zones = await db
    .selectFrom("sd_zones")
    .select(["id", "name"])
    .where("id", "in", [booking.from_zone_id, booking.to_zone_id])
    .execute();
  const name = (id: string) => zones.find((z) => z.id === id)?.name ?? id;
  const extras = await extrasOf(db, booking.id);
  const terms = await buyerTerms(db, booking);
  if (terms.classes.length > 0 && !terms.classes.includes(offer.class_key))
    throw new Error("gone");
  const discount = buyerPrice(offer, terms.discountPct) - offer.price_minor;
  const lines = [
    {
      kind: "base",
      label: `${name(booking.from_zone_id)} → ${name(booking.to_zone_id)}, ${vehicleClass.name}`,
      amount_minor: offer.price_minor,
    },
    ...extras.map((e) => ({
      kind: "extra",
      label: e.name,
      key: e.extra_key,
      qty: e.qty,
      amount_minor: e.price_minor,
    })),
    ...(discount
      ? [
          {
            kind: "discount",
            label: `${booking.agency_id ? "Acente indirimi" : "Kurumsal indirim"} (%${terms.discountPct})`,
            amount_minor: discount,
          },
        ]
      : []),
  ];
  const total = lines.reduce((sum, l) => sum + l.amount_minor, 0);
  await updateBooking(db, booking, {
    status: "confirmed",
    class_key: offer.class_key,
    price_minor: total,
    breakdown: JSON.stringify(lines),
    payout_minor: offer.bidder_kind === "ops" ? null : offer.payout_minor,
  });
  const now = new Date().toISOString();
  await db
    .updateTable("sd_offers")
    .set((eb) => ({
      status: eb
        .case()
        .when("id", "=", offer.id)
        .then("won")
        .else("lost")
        .end(),
      updated_at: now,
    }))
    .where("booking_id", "=", booking.id)
    .where("status", "=", "active")
    .execute();
  await addEvent(
    db,
    booking.id,
    actor,
    "offer_picked",
    "bidding",
    "confirmed",
    { bidder: offer.bidder_kind, price_minor: total },
  );
  const confirmed = (await getBookingByCode(db, booking.code))!;
  if (offer.bidder_kind !== "ops") {
    await handToCarrier(
      db,
      confirmed,
      {
        kind: offer.bidder_kind,
        id: offer.bidder_id,
        amountMinor: offer.payout_minor,
      },
      actor,
      offer.note,
      "offer_awarded",
    );
  }
  return (await getBookingByCode(db, booking.code))!;
}

export interface OpenRequest {
  code: string;
  pickup_at: string;
  pax: number;
  bags: number;
  flight_no: string | null;
  from_name: string;
  to_name: string;
  from_kind: string;
  to_kind: string;
  notes: string | null;
  extras: string | null;
  offers: number;
  best_price: number | null;
  my_class: string | null;
  my_amount: number | null;
  my_vehicle: string | null;
  my_status: string | null;
  /** A company request accepts only the classes in its contract; empty means any. */
  allowed_classes: string[];
}

/**
 * Open requests as a bidder sees them: the trip, how many offers and its own. Never
 * the passenger's name or contact details. Drivers see only trips their class fits.
 */
export async function openRequestsFor(
  db: Db,
  bidder: OfferBidder,
  fit?: { paxMax: number; bagsMax: number },
): Promise<OpenRequest[]> {
  let query = db
    .selectFrom("sd_bookings as b")
    .innerJoin("sd_zones as f", "f.id", "b.from_zone_id")
    .innerJoin("sd_zones as t", "t.id", "b.to_zone_id")
    .leftJoin("sd_offers as mine", (join) =>
      join
        .onRef("mine.booking_id", "=", "b.id")
        .on("mine.bidder_kind", "=", bidder.kind)
        .on("mine.bidder_id", "=", bidder.id),
    )
    .select((eb) => [
      "b.code",
      "b.pickup_at",
      "b.pax",
      "b.bags",
      "b.flight_no",
      "b.notes",
      "b.org_id",
      "b.agency_id",
      "b.payment_method",
      "f.name as from_name",
      "t.name as to_name",
      "f.kind as from_kind",
      "t.kind as to_kind",
      "mine.class_key as my_class",
      "mine.vehicle as my_vehicle",
      "mine.status as my_status",
      sql<
        number | null
      >`case when mine.bidder_kind = 'ops' then mine.price_minor else mine.payout_minor end`.as(
        "my_amount",
      ),
      eb
        .selectFrom("sd_offers as x")
        .select(eb.fn.countAll<number>().as("n"))
        .whereRef("x.booking_id", "=", "b.id")
        .where("x.status", "=", "active")
        .as("offers"),
      eb
        .selectFrom("sd_offers as y")
        .select(eb.fn.min<number>("y.price_minor").as("p"))
        .whereRef("y.booking_id", "=", "b.id")
        .where("y.status", "=", "active")
        .as("best_price"),
      eb
        .selectFrom("sd_booking_extras as e")
        .select(
          sql<string>`group_concat(e.name || case when e.qty > 1 then ' ×' || e.qty else '' end, ', ')`.as(
            "x",
          ),
        )
        .whereRef("e.booking_id", "=", "b.id")
        .as("extras"),
    ])
    .where("b.status", "=", "bidding")
    .where(
      "b.pickup_at",
      ">",
      new Date(Date.now() + CLOSE_BEFORE_MS).toISOString(),
    );
  if (fit)
    query = query
      .where("b.pax", "<=", fit.paxMax)
      .where("b.bags", "<=", fit.bagsMax);
  const rows = await query.orderBy("b.pickup_at").limit(100).execute();
  // Carriers bid blind: only ops sees the best price, and free text loses contact details.
  const out: OpenRequest[] = [];
  for (const { org_id, agency_id, payment_method, ...r } of rows) {
    const { classes } = await buyerTerms(db, {
      org_id,
      agency_id,
      payment_method,
    } as Booking);
    out.push({
      ...r,
      allowed_classes: classes,
      offers: Number(r.offers ?? 0),
      best_price: bidder.kind === "ops" ? r.best_price : null,
      notes: r.notes && bidder.kind !== "ops" ? maskContacts(r.notes) : r.notes,
    } as OpenRequest);
  }
  return out;
}

/** Active vehicle classes big enough for a request, smallest first. */
export async function classesFitting(db: Db, pax: number, bags: number) {
  return db
    .selectFrom("sd_vehicle_classes")
    .select(["key", "name", "pax_max", "bags_max"])
    .where("active", "=", 1)
    .where("pax_max", ">=", pax)
    .where("bags_max", ">=", bags)
    .orderBy("pax_max")
    .orderBy("sort")
    .execute();
}

export async function getOpenRequest(
  db: Db,
  code: string,
): Promise<Booking | null> {
  const booking = await getBookingByCode(db, code);
  return booking && booking.status === "bidding" ? booking : null;
}

/** Open requests for menu counts: ones without any offer yet. */
export async function countUnansweredRequests(db: Db): Promise<number> {
  const row = await db
    .selectFrom("sd_bookings as b")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("b.status", "=", "bidding")
    .where(
      "b.pickup_at",
      ">",
      new Date(Date.now() + CLOSE_BEFORE_MS).toISOString(),
    )
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("sd_offers as o")
            .select("o.id")
            .whereRef("o.booking_id", "=", "b.id")
            .where("o.status", "=", "active"),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Requests nobody picked an offer for by an hour before pickup are closed. */
export async function expireRequests(db: Db): Promise<void> {
  const due = (await db
    .selectFrom("sd_bookings")
    .selectAll()
    .where("status", "=", "bidding")
    .where(
      "pickup_at",
      "<=",
      new Date(Date.now() + CLOSE_BEFORE_MS).toISOString(),
    )
    .limit(20)
    .execute()) as Booking[];
  for (const booking of due) {
    try {
      await transition(db, booking, "cancelled", SYSTEM, {
        reason: "Teklif seçilmeden alış saatine yaklaşıldı",
        refundPct: 0,
      });
      await db
        .updateTable("sd_offers")
        .set({ status: "lost", updated_at: new Date().toISOString() })
        .where("booking_id", "=", booking.id)
        .where("status", "=", "active")
        .execute();
    } catch (error) {
      if (!(error instanceof ConflictError))
        console.error("offers", booking.code, error);
    }
  }
}
