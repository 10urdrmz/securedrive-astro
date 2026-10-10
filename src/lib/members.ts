/**
 * Customer accounts: sign-up and sign-in with a username and password.
 *
 * Members are the site's customers and are kept apart from EmDash users (the
 * admin team, who sign in with passkeys). They live in three tables of their own
 * in the site database, created on first use:
 *
 *   sd_members          one row per customer, password stored as a salted PBKDF2 hash
 *   sd_member_sessions  sign-in sessions; only a hash of the cookie token is stored
 *   sd_member_attempts  counters that slow down password guessing and bulk sign-ups
 *   sd_member_requests  which inquiry was sent by which member
 *
 * These tables hold personal data. Never render them on a public page.
 */
import type { AstroGlobal } from "astro";
import { getDb } from "emdash/runtime";

export interface Member {
	id: string;
	username: string;
	email: string;
	name: string;
	phone: string | null;
	created_at: string;
}

interface MemberRow extends Member {
	password_hash: string;
}

export const SESSION_COOKIE = "sd_session";
const SESSION_DAYS = 30;
/** Cloudflare Workers caps PBKDF2 at 100,000 iterations. */
const PBKDF2_ITERATIONS = 100_000;

export const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,22})[a-z0-9]$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE = /^\+?[0-9 ()-]{7,20}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// The tables are not part of EmDash's typed schema, so queries go through an untyped handle.
type Db = any;

let ready: Promise<void> | undefined;

/** Create the member tables if this database does not have them yet. */
function ensureTables(db: Db): Promise<void> {
	ready ??= (async () => {
		await db.schema
			.createTable("sd_members")
			.ifNotExists()
			.addColumn("id", "text", (c: any) => c.primaryKey())
			.addColumn("username", "text", (c: any) => c.notNull().unique())
			.addColumn("email", "text", (c: any) => c.notNull().unique())
			.addColumn("name", "text", (c: any) => c.notNull())
			.addColumn("phone", "text")
			.addColumn("password_hash", "text", (c: any) => c.notNull())
			.addColumn("locale", "text")
			.addColumn("consent_at", "text", (c: any) => c.notNull())
			.addColumn("created_at", "text", (c: any) => c.notNull())
			.addColumn("updated_at", "text", (c: any) => c.notNull())
			.execute();
		await db.schema
			.createTable("sd_member_sessions")
			.ifNotExists()
			.addColumn("token_hash", "text", (c: any) => c.primaryKey())
			.addColumn("member_id", "text", (c: any) => c.notNull())
			.addColumn("created_at", "text", (c: any) => c.notNull())
			.addColumn("expires_at", "text", (c: any) => c.notNull())
			.execute();
		await db.schema
			.createTable("sd_member_attempts")
			.ifNotExists()
			.addColumn("key", "text", (c: any) => c.primaryKey())
			.addColumn("count", "integer", (c: any) => c.notNull())
			.addColumn("window_start", "integer", (c: any) => c.notNull())
			.execute();
		// Which member sent which inquiry (written by plugins/inquiries on submit).
		await db.schema
			.createTable("sd_member_requests")
			.ifNotExists()
			.addColumn("inquiry_id", "text", (c: any) => c.primaryKey())
			.addColumn("member_id", "text", (c: any) => c.notNull())
			.addColumn("created_at", "text", (c: any) => c.notNull())
			.execute();
		await db.schema
			.createIndex("sd_member_requests_member")
			.ifNotExists()
			.on("sd_member_requests")
			.columns(["member_id", "created_at"])
			.execute();
	})().catch((error) => {
		ready = undefined;
		throw error;
	});
	return ready;
}

/** The site database (SQLite locally, D1 on Cloudflare), with the member tables in place. */
async function membersDb(): Promise<Db> {
	const db: Db = await getDb();
	await ensureTables(db);
	return db;
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function randomToken(bytes: number): string {
	const buffer = crypto.getRandomValues(new Uint8Array(bytes));
	return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
	return new Uint8Array(bits);
}

/** "pbkdf2-sha256$<iterations>$<salt>$<hash>", so the cost can be raised later without breaking old hashes. */
async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, iterations, salt, expected] = stored.split("$");
	if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !expected) return false;
	const actual = await pbkdf2(password, fromBase64(salt), Number(iterations));
	const wanted = fromBase64(expected);
	if (actual.length !== wanted.length) return false;
	// Compare every byte so the time taken does not reveal how much matched.
	let diff = 0;
	for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ wanted[i]!;
	return diff === 0;
}

/** A hash to verify against when the account does not exist, so both cases take the same time. */
let decoyHash: Promise<string> | undefined;

function publicMember(row: MemberRow): Member {
	const { id, username, email, name, phone, created_at } = row;
	return { id, username, email, name, phone, created_at };
}

/** Visitor address, hashed before it is used as a rate-limit key. */
async function visitorKey(Astro: AstroGlobal): Promise<string> {
	let address = "unknown";
	try {
		address = Astro.clientAddress;
	} catch {
		// Not every adapter can tell; all such visitors then share one counter.
	}
	return (await sha256(`${address}|members`)).slice(0, 24);
}

/**
 * Count one attempt against `key` and report whether it is still within the limit.
 * Counters reset once their window has passed.
 */
async function allowAttempt(db: Db, key: string, max: number, windowMinutes: number): Promise<boolean> {
	const now = Date.now();
	const row = await db.selectFrom("sd_member_attempts").selectAll().where("key", "=", key).executeTakeFirst();
	if (!row || now - Number(row.window_start) > windowMinutes * 60_000) {
		await db.deleteFrom("sd_member_attempts").where("key", "=", key).execute();
		await db.insertInto("sd_member_attempts").values({ key, count: 1, window_start: now }).execute();
		return true;
	}
	if (Number(row.count) >= max) return false;
	await db
		.updateTable("sd_member_attempts")
		.set({ count: Number(row.count) + 1 })
		.where("key", "=", key)
		.execute();
	return true;
}

export type RegisterError =
	| "nameRequired"
	| "usernameInvalid"
	| "usernameTaken"
	| "emailInvalid"
	| "emailTaken"
	| "phoneInvalid"
	| "passwordShort"
	| "passwordMismatch"
	| "consent"
	| "rate";

export interface RegisterInput {
	name: string;
	username: string;
	email: string;
	phone: string;
	password: string;
	passwordRepeat: string;
	consent: boolean;
	locale: string;
}

const clean = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

export async function registerMember(
	Astro: AstroGlobal,
	input: RegisterInput,
): Promise<{ ok: true; member: Member } | { ok: false; error: RegisterError }> {
	const name = clean(input.name, 80);
	const username = clean(input.username, 40).toLowerCase();
	const email = clean(input.email, 120).toLowerCase();
	const phone = clean(input.phone, 24);

	if (name.length < 2) return { ok: false, error: "nameRequired" };
	if (!USERNAME.test(username)) return { ok: false, error: "usernameInvalid" };
	if (!EMAIL.test(email)) return { ok: false, error: "emailInvalid" };
	if (phone && !PHONE.test(phone)) return { ok: false, error: "phoneInvalid" };
	if (input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) {
		return { ok: false, error: "passwordShort" };
	}
	if (input.password !== input.passwordRepeat) return { ok: false, error: "passwordMismatch" };
	if (!input.consent) return { ok: false, error: "consent" };

	const db = await membersDb();
	if (!(await allowAttempt(db, `register:${await visitorKey(Astro)}`, 5, 60))) return { ok: false, error: "rate" };

	const taken = await db
		.selectFrom("sd_members")
		.select(["username", "email"])
		.where((eb: any) => eb.or([eb("username", "=", username), eb("email", "=", email)]))
		.execute();
	if (taken.some((row: { username: string }) => row.username === username)) return { ok: false, error: "usernameTaken" };
	if (taken.length > 0) return { ok: false, error: "emailTaken" };

	const now = new Date().toISOString();
	const row: MemberRow = {
		id: randomToken(12),
		username,
		email,
		name,
		phone: phone || null,
		password_hash: await hashPassword(input.password),
		created_at: now,
	};
	try {
		await db
			.insertInto("sd_members")
			.values({ ...row, locale: input.locale, consent_at: now, updated_at: now })
			.execute();
	} catch {
		// Two sign-ups raced for the same name; the unique index let only one through.
		return { ok: false, error: "usernameTaken" };
	}
	return { ok: true, member: publicMember(row) };
}

/**
 * Check a username (or e-mail address) and password. Failures are deliberately
 * indistinguishable: a wrong password and an unknown account look the same.
 */
export async function authenticate(
	Astro: AstroGlobal,
	identifier: string,
	password: string,
): Promise<{ ok: true; member: Member } | { ok: false; error: "invalid" | "rate" }> {
	const login = clean(identifier, 120).toLowerCase();
	if (!login || !password || password.length > PASSWORD_MAX) return { ok: false, error: "invalid" };

	const db = await membersDb();
	const visitor = await visitorKey(Astro);
	const account = (await sha256(`${login}|account`)).slice(0, 24);
	const allowed =
		(await allowAttempt(db, `login:${visitor}`, 20, 15)) && (await allowAttempt(db, `login-as:${account}`, 10, 15));
	if (!allowed) return { ok: false, error: "rate" };

	const row: MemberRow | undefined = await db
		.selectFrom("sd_members")
		.selectAll()
		.where(login.includes("@") ? "email" : "username", "=", login)
		.executeTakeFirst();
	if (!row) {
		decoyHash ??= hashPassword(randomToken(16));
		await verifyPassword(password, await decoyHash);
		return { ok: false, error: "invalid" };
	}
	if (!(await verifyPassword(password, row.password_hash))) return { ok: false, error: "invalid" };

	await db.deleteFrom("sd_member_attempts").where("key", "=", `login-as:${account}`).execute();
	return { ok: true, member: publicMember(row) };
}

/** Start a session for a member and set its cookie. */
export async function startSession(Astro: AstroGlobal, memberId: string): Promise<void> {
	const db = await membersDb();
	const token = randomToken(32);
	const now = Date.now();
	const expires = new Date(now + SESSION_DAYS * 86_400_000);
	await db.deleteFrom("sd_member_sessions").where("expires_at", "<", new Date(now).toISOString()).execute();
	await db
		.insertInto("sd_member_sessions")
		.values({
			token_hash: await sha256(token),
			member_id: memberId,
			created_at: new Date(now).toISOString(),
			expires_at: expires.toISOString(),
		})
		.execute();
	Astro.cookies.set(SESSION_COOKIE, token, {
		path: "/",
		httpOnly: true,
		secure: Astro.url.protocol === "https:",
		sameSite: "lax",
		expires,
	});
}

/** The signed-in member of this request, if any. */
export async function currentMember(Astro: Pick<AstroGlobal, "cookies">): Promise<Member | null> {
	const token = Astro.cookies.get(SESSION_COOKIE)?.value;
	if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
	const db = await membersDb();
	const session = await db
		.selectFrom("sd_member_sessions")
		.select(["member_id", "expires_at"])
		.where("token_hash", "=", await sha256(token))
		.executeTakeFirst();
	if (!session || session.expires_at < new Date().toISOString()) return null;
	const row: MemberRow | undefined = await db
		.selectFrom("sd_members")
		.selectAll()
		.where("id", "=", session.member_id)
		.executeTakeFirst();
	return row ? publicMember(row) : null;
}

/** End the session of this request and clear its cookie. */
export async function endSession(Astro: AstroGlobal): Promise<void> {
	const token = Astro.cookies.get(SESSION_COOKIE)?.value;
	if (token) {
		const db = await membersDb();
		await db.deleteFrom("sd_member_sessions").where("token_hash", "=", await sha256(token)).execute();
	}
	Astro.cookies.delete(SESSION_COOKIE, { path: "/" });
}

export type ProfileError = "nameRequired" | "emailInvalid" | "emailTaken" | "phoneInvalid";

export async function updateProfile(
	member: Member,
	input: { name: string; email: string; phone: string },
): Promise<{ ok: true } | { ok: false; error: ProfileError }> {
	const name = clean(input.name, 80);
	const email = clean(input.email, 120).toLowerCase();
	const phone = clean(input.phone, 24);
	if (name.length < 2) return { ok: false, error: "nameRequired" };
	if (!EMAIL.test(email)) return { ok: false, error: "emailInvalid" };
	if (phone && !PHONE.test(phone)) return { ok: false, error: "phoneInvalid" };

	const db = await membersDb();
	if (email !== member.email) {
		const other = await db.selectFrom("sd_members").select("id").where("email", "=", email).executeTakeFirst();
		if (other) return { ok: false, error: "emailTaken" };
	}
	await db
		.updateTable("sd_members")
		.set({ name, email, phone: phone || null, updated_at: new Date().toISOString() })
		.where("id", "=", member.id)
		.execute();
	return { ok: true };
}

export type PasswordError = "currentPassword" | "passwordShort" | "passwordMismatch" | "rate";

/** Change the password and sign out every other session of the member. */
export async function changePassword(
	Astro: AstroGlobal,
	member: Member,
	input: { current: string; next: string; repeat: string },
): Promise<{ ok: true } | { ok: false; error: PasswordError }> {
	if (input.next.length < PASSWORD_MIN || input.next.length > PASSWORD_MAX) return { ok: false, error: "passwordShort" };
	if (input.next !== input.repeat) return { ok: false, error: "passwordMismatch" };

	const db = await membersDb();
	if (!(await allowAttempt(db, `password:${member.id}`, 10, 15))) return { ok: false, error: "rate" };
	const row = await db.selectFrom("sd_members").select("password_hash").where("id", "=", member.id).executeTakeFirst();
	if (!row || input.current.length > PASSWORD_MAX || !(await verifyPassword(input.current, row.password_hash))) {
		return { ok: false, error: "currentPassword" };
	}
	await db
		.updateTable("sd_members")
		.set({ password_hash: await hashPassword(input.next), updated_at: new Date().toISOString() })
		.where("id", "=", member.id)
		.execute();
	await db.deleteFrom("sd_member_sessions").where("member_id", "=", member.id).execute();
	await startSession(Astro, member.id);
	return { ok: true };
}

/** Steps a request moves through, as set by the operations team in the admin. */
export const REQUEST_STATUSES = ["new", "contacted", "quoted", "booked", "closed"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface MemberRequest {
	/** Entry id. Long and random, so it doubles as the secret in the tracking link. */
	id: string;
	/** Request number, e.g. "SD-2610-0042"; empty for an entry saved without one. */
	reference: string;
	status: RequestStatus;
	submittedAt: string;
	from: string;
	to: string;
	date?: string;
	time?: string;
	passengers?: number;
	vehicle?: string;
	flight?: string;
	returnTrip: boolean;
}

interface RequestRow {
	id: string;
	reference: string | null;
	status_label: string | null;
	details: unknown;
	created_at: string;
}

const REQUEST_COLUMNS = [
	"i.id as id",
	"i.reference as reference",
	"i.status_label as status_label",
	"i.details as details",
] as const;

/** Only the trip itself leaves the inquiries table: never the name, phone, e-mail, message or notes. */
function toRequest(row: RequestRow): MemberRequest {
	let details: Record<string, unknown> = {};
	try {
		details = (typeof row.details === "string" ? JSON.parse(row.details) : row.details) ?? {};
	} catch {
		// A malformed entry still shows up, just without its trip details.
	}
	const text = (key: string) => (typeof details[key] === "string" ? (details[key] as string) : undefined);
	const status = (REQUEST_STATUSES as readonly string[]).includes(row.status_label ?? "") ? row.status_label : "new";
	return {
		id: row.id,
		reference: row.reference ?? "",
		status: status as RequestStatus,
		submittedAt: row.created_at,
		from: text("from") ?? "",
		to: text("to") ?? "",
		date: text("date"),
		time: text("time"),
		passengers: typeof details.passengers === "number" ? details.passengers : undefined,
		vehicle: text("vehicle"),
		flight: text("flight"),
		returnTrip: details.return_trip === true,
	};
}

/**
 * Transfer requests this member sent while signed in, newest first. Only rows
 * linked to the member are read: the inquiries collection also holds other
 * people's personal data.
 */
export async function memberRequests(member: Member): Promise<MemberRequest[]> {
	const db = await membersDb();
	const rows: RequestRow[] = await db
		.selectFrom("sd_member_requests as r")
		.innerJoin("ec_inquiries as i", "i.id", "r.inquiry_id")
		.select([...REQUEST_COLUMNS, "r.created_at as created_at"])
		.where("r.member_id", "=", member.id)
		.where("i.kind", "=", "transfer")
		.where("i.deleted_at", "is", null)
		.orderBy("r.created_at", "desc")
		.limit(50)
		.execute();
	return rows.map(toRequest);
}

/** Tracking ids are entry ids: 26 characters of Crockford base32. */
const TRACKING_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The transfer request behind a tracking link, for the member who sent it.
 * Anyone else, signed in or not, gets nothing: the link alone is not enough.
 */
export async function trackedRequest(trackingId: string, member: Member): Promise<MemberRequest | null> {
	const id = trackingId.toUpperCase();
	if (!TRACKING_ID.test(id)) return null;
	const db = await membersDb();
	const row: RequestRow | undefined = await db
		.selectFrom("sd_member_requests as r")
		.innerJoin("ec_inquiries as i", "i.id", "r.inquiry_id")
		.select([...REQUEST_COLUMNS, "r.created_at as created_at"])
		.where("r.inquiry_id", "=", id)
		.where("r.member_id", "=", member.id)
		.where("i.kind", "=", "transfer")
		.where("i.deleted_at", "is", null)
		.executeTakeFirst();
	return row ? toRequest(row) : null;
}

/**
 * Find a transfer request for a visitor who is not signed in. They must give the
 * request number and the phone number or e-mail address the request was sent
 * with; a number alone is not enough, because numbers are sequential. Every
 * failure looks the same, and attempts are limited per visitor.
 */
export async function lookupRequest(
	Astro: AstroGlobal,
	referenceInput: string,
	contactInput: string,
): Promise<{ ok: true; request: MemberRequest } | { ok: false; error: "notFound" | "rate" }> {
	const reference = referenceInput.replace(/\s+/g, "").toUpperCase().slice(0, 24);
	const contact = clean(contactInput, 120).toLowerCase();
	if (!reference || !contact) return { ok: false, error: "notFound" };

	const db = await membersDb();
	if (!(await allowAttempt(db, `lookup:${await visitorKey(Astro)}`, 10, 15))) return { ok: false, error: "rate" };

	const row: (RequestRow & { phone: string | null; email: string | null }) | undefined = await db
		.selectFrom("ec_inquiries as i")
		.select([...REQUEST_COLUMNS, "i.created_at as created_at", "i.phone as phone", "i.email as email"])
		.where("i.reference", "=", reference)
		.where("i.kind", "=", "transfer")
		.where("i.deleted_at", "is", null)
		.executeTakeFirst();
	if (!row) return { ok: false, error: "notFound" };

	// Phones are compared by their last ten digits, so "+90 555…", "0555…" and "555…" all match.
	const digits = (value: string) => value.replace(/\D/g, "");
	const given = digits(contact);
	const phoneMatches = given.length >= 10 && digits(row.phone ?? "").endsWith(given.slice(-10));
	const emailMatches = contact.includes("@") && contact === (row.email ?? "").toLowerCase();
	if (!phoneMatches && !emailMatches) return { ok: false, error: "notFound" };
	return { ok: true, request: toRequest(row) };
}
