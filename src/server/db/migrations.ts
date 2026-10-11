/**
 * Business schema (sd_* tables). EmDash owns its own tables; these are ours.
 *
 * Each migration is a list of SQL statements run in order, exactly once, recorded in
 * sd_migrations. Statements must be idempotent (IF NOT EXISTS / INSERT OR IGNORE) because
 * two Worker isolates can race on the very first request after a deploy.
 *
 * Never edit a migration that has shipped: add a new one.
 * Conventions: ids are ULIDs, money is integer minor units (kuruş), times are ISO-8601 UTC.
 */
import { ISTANBUL_DISTRICTS } from "./catalog";

export interface Migration {
	name: string;
	statements: string[];
}

const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export const MIGRATIONS: Migration[] = [
	{
		name: "0001_identity",
		statements: [
			`CREATE TABLE IF NOT EXISTS sd_users (
				id TEXT PRIMARY KEY,
				email TEXT UNIQUE,
				phone TEXT UNIQUE,
				username TEXT UNIQUE,
				name TEXT NOT NULL,
				password_hash TEXT,
				locale TEXT NOT NULL DEFAULT 'tr',
				status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleted')),
				failed_logins INTEGER NOT NULL DEFAULT 0,
				locked_until TEXT,
				last_login_at TEXT,
				created_at TEXT NOT NULL DEFAULT (${NOW}),
				updated_at TEXT NOT NULL DEFAULT (${NOW})
			)`,
			`CREATE TABLE IF NOT EXISTS sd_orgs (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL CHECK (kind IN ('internal','company','agency','carrier')),
				name TEXT NOT NULL,
				legal_name TEXT,
				tax_no TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				settings TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL DEFAULT (${NOW})
			)`,
			// org_id is '' (not NULL) for roles without an organisation, so the unique key holds.
			`CREATE TABLE IF NOT EXISTS sd_memberships (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL REFERENCES sd_users(id),
				org_id TEXT NOT NULL DEFAULT '',
				role TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (${NOW}),
				UNIQUE (user_id, org_id, role)
			)`,
			`CREATE INDEX IF NOT EXISTS sd_memberships_role ON sd_memberships(role)`,
			`CREATE TABLE IF NOT EXISTS sd_sessions (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL REFERENCES sd_users(id),
				panel TEXT NOT NULL,
				user_agent TEXT,
				created_at TEXT NOT NULL DEFAULT (${NOW}),
				last_seen_at TEXT NOT NULL DEFAULT (${NOW}),
				expires_at TEXT NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS sd_sessions_user ON sd_sessions(user_id)`,
			`CREATE TABLE IF NOT EXISTS sd_audit_log (
				id TEXT PRIMARY KEY,
				at TEXT NOT NULL DEFAULT (${NOW}),
				actor_user_id TEXT,
				action TEXT NOT NULL,
				entity TEXT NOT NULL,
				entity_id TEXT,
				data TEXT NOT NULL DEFAULT '{}'
			)`,
			`CREATE INDEX IF NOT EXISTS sd_audit_entity ON sd_audit_log(entity, entity_id)`,
			`CREATE TABLE IF NOT EXISTS sd_settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_by TEXT,
				updated_at TEXT NOT NULL DEFAULT (${NOW})
			)`,
			`CREATE TABLE IF NOT EXISTS sd_counters (
				key TEXT PRIMARY KEY,
				value INTEGER NOT NULL DEFAULT 0
			)`,
			`INSERT OR IGNORE INTO sd_orgs (id, kind, name) VALUES ('internal', 'internal', 'SecureDrive')`,
		],
	},
	{
		name: "0002_catalog",
		statements: [
			`CREATE TABLE IF NOT EXISTS sd_zones (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL CHECK (kind IN ('airport','district','poi')),
				name TEXT NOT NULL,
				serviceable INTEGER NOT NULL DEFAULT 1,
				sort INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (${NOW})
			)`,
			`CREATE TABLE IF NOT EXISTS sd_vehicle_classes (
				key TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				pax_max INTEGER NOT NULL,
				bags_max INTEGER NOT NULL,
				sort INTEGER NOT NULL DEFAULT 0,
				active INTEGER NOT NULL DEFAULT 1
			)`,
			// org_id '' = public tariff; a company or agency id = that customer's own price.
			`CREATE TABLE IF NOT EXISTS sd_tariffs (
				id TEXT PRIMARY KEY,
				from_zone_id TEXT NOT NULL REFERENCES sd_zones(id),
				to_zone_id TEXT NOT NULL REFERENCES sd_zones(id),
				class_key TEXT NOT NULL REFERENCES sd_vehicle_classes(key),
				org_id TEXT NOT NULL DEFAULT '',
				price_minor INTEGER NOT NULL CHECK (price_minor > 0),
				driver_payout_minor INTEGER,
				currency TEXT NOT NULL DEFAULT 'TRY',
				updated_by TEXT,
				updated_at TEXT NOT NULL DEFAULT (${NOW}),
				UNIQUE (from_zone_id, to_zone_id, class_key, org_id)
			)`,
			`CREATE TABLE IF NOT EXISTS sd_extras (
				key TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				price_minor INTEGER NOT NULL DEFAULT 0,
				max_qty INTEGER NOT NULL DEFAULT 1,
				active INTEGER NOT NULL DEFAULT 1,
				sort INTEGER NOT NULL DEFAULT 0
			)`,
			// IST and SAW, then every Istanbul district. Adalar exists but is not served.
			`INSERT OR IGNORE INTO sd_zones (id, kind, name, sort) VALUES
				('ist', 'airport', 'İstanbul Havalimanı (IST)', 1),
				('saw', 'airport', 'Sabiha Gökçen Havalimanı (SAW)', 2)`,
			`INSERT OR IGNORE INTO sd_zones (id, kind, name, serviceable, sort) VALUES ${ISTANBUL_DISTRICTS.map(
				(d, i) => `(${q(d.id)}, 'district', ${q(d.name)}, ${d.serviceable ? 1 : 0}, ${100 + i})`,
			).join(", ")}`,
			// Keys match the EmDash "vehicles" entries so the fleet page can show live prices.
			`INSERT OR IGNORE INTO sd_vehicle_classes (key, name, pax_max, bags_max, sort) VALUES
				('mercedes-vito-vip', 'Mercedes-Benz Vito VIP', 6, 6, 1),
				('mercedes-sprinter-vip', 'Mercedes-Benz Sprinter VIP', 14, 14, 2)`,
			`INSERT OR IGNORE INTO sd_extras (key, name, price_minor, max_qty, sort) VALUES
				('child-seat', 'Bebek / çocuk koltuğu', 0, 2, 1),
				('extra-stop', 'Ara durak', 0, 3, 2),
				('meet-greet', 'İsimli karşılama tabelası', 0, 1, 3)`,
			// Price rules and policies start as editable defaults (see src/server/settings.ts).
		],
	},
	{
		name: "0003_bookings",
		statements: [
			// One row per confirmed transfer, whichever way it came in (web wizard, phone, later B2B).
			// customer_member_id points at sd_members (site accounts); staff live in sd_users.
			`CREATE TABLE IF NOT EXISTS sd_bookings (
				id TEXT PRIMARY KEY,
				code TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 1,
				source TEXT NOT NULL DEFAULT 'web',
				locale TEXT NOT NULL DEFAULT 'tr',
				customer_member_id TEXT,
				org_id TEXT NOT NULL DEFAULT '',
				from_zone_id TEXT NOT NULL REFERENCES sd_zones(id),
				to_zone_id TEXT NOT NULL REFERENCES sd_zones(id),
				pickup_address TEXT,
				dropoff_address TEXT,
				pickup_at TEXT NOT NULL,
				flight_no TEXT,
				pax INTEGER NOT NULL,
				bags INTEGER NOT NULL DEFAULT 0,
				class_key TEXT NOT NULL REFERENCES sd_vehicle_classes(key),
				contact_name TEXT NOT NULL,
				contact_phone TEXT NOT NULL,
				contact_email TEXT,
				sign_name TEXT,
				notes TEXT,
				internal_notes TEXT,
				price_minor INTEGER NOT NULL,
				currency TEXT NOT NULL DEFAULT 'TRY',
				breakdown TEXT NOT NULL DEFAULT '[]',
				payout_minor INTEGER,
				payment_method TEXT NOT NULL,
				payment_status TEXT NOT NULL DEFAULT 'unpaid',
				driver_id TEXT,
				cancel_reason TEXT,
				refund_pct INTEGER,
				tracking_token TEXT NOT NULL,
				created_by TEXT,
				created_at TEXT NOT NULL DEFAULT (${NOW}),
				updated_at TEXT NOT NULL DEFAULT (${NOW})
			)`,
			`CREATE INDEX IF NOT EXISTS sd_bookings_status_pickup ON sd_bookings(status, pickup_at)`,
			`CREATE INDEX IF NOT EXISTS sd_bookings_pickup ON sd_bookings(pickup_at)`,
			`CREATE INDEX IF NOT EXISTS sd_bookings_customer ON sd_bookings(customer_member_id, pickup_at)`,
			`CREATE INDEX IF NOT EXISTS sd_bookings_driver ON sd_bookings(driver_id, pickup_at)`,
			`CREATE TABLE IF NOT EXISTS sd_booking_extras (
				booking_id TEXT NOT NULL REFERENCES sd_bookings(id),
				extra_key TEXT NOT NULL,
				name TEXT NOT NULL,
				qty INTEGER NOT NULL,
				price_minor INTEGER NOT NULL,
				PRIMARY KEY (booking_id, extra_key)
			)`,
			`CREATE TABLE IF NOT EXISTS sd_booking_events (
				id TEXT PRIMARY KEY,
				booking_id TEXT NOT NULL REFERENCES sd_bookings(id),
				at TEXT NOT NULL DEFAULT (${NOW}),
				actor_user_id TEXT,
				actor TEXT NOT NULL,
				type TEXT NOT NULL,
				from_status TEXT,
				to_status TEXT,
				data TEXT NOT NULL DEFAULT '{}'
			)`,
			`CREATE INDEX IF NOT EXISTS sd_booking_events_booking ON sd_booking_events(booking_id, at)`,
			// Phase 3 drivers are records the ops team keeps; they sign in from phase 4 (user_id).
			`CREATE TABLE IF NOT EXISTS sd_drivers (
				id TEXT PRIMARY KEY,
				user_id TEXT,
				name TEXT NOT NULL,
				phone TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff','partner','independent')),
				class_key TEXT REFERENCES sd_vehicle_classes(key),
				plate TEXT,
				vehicle TEXT,
				languages TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
				notes TEXT,
				created_at TEXT NOT NULL DEFAULT (${NOW})
			)`,
			`CREATE TABLE IF NOT EXISTS sd_assignments (
				id TEXT PRIMARY KEY,
				booking_id TEXT NOT NULL REFERENCES sd_bookings(id),
				driver_id TEXT NOT NULL REFERENCES sd_drivers(id),
				status TEXT NOT NULL CHECK (status IN ('accepted','released','reassigned','done')),
				mode TEXT NOT NULL DEFAULT 'manual',
				payout_minor INTEGER,
				assigned_by TEXT,
				created_at TEXT NOT NULL DEFAULT (${NOW}),
				ended_at TEXT
			)`,
			`CREATE INDEX IF NOT EXISTS sd_assignments_booking ON sd_assignments(booking_id)`,
			`CREATE INDEX IF NOT EXISTS sd_assignments_driver ON sd_assignments(driver_id, status)`,
			// Money that moved: cash collected by the driver, card in the vehicle, later online payments and refunds.
			`CREATE TABLE IF NOT EXISTS sd_payments (
				id TEXT PRIMARY KEY,
				booking_id TEXT NOT NULL REFERENCES sd_bookings(id),
				provider TEXT NOT NULL,
				method TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'charge' CHECK (kind IN ('charge','refund')),
				amount_minor INTEGER NOT NULL,
				currency TEXT NOT NULL DEFAULT 'TRY',
				status TEXT NOT NULL,
				provider_ref TEXT,
				recorded_by TEXT,
				note TEXT,
				created_at TEXT NOT NULL DEFAULT (${NOW})
			)`,
			`CREATE INDEX IF NOT EXISTS sd_payments_booking ON sd_payments(booking_id)`,
		],
	},
	{
		name: "0004_reviews_and_requests",
		statements: [
			// One review per booking, written by the passenger after the trip.
			`CREATE TABLE IF NOT EXISTS sd_reviews (
				booking_id TEXT PRIMARY KEY REFERENCES sd_bookings(id),
				rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
				comment TEXT,
				driver_id TEXT,
				created_at TEXT NOT NULL DEFAULT (${NOW})
			)`,
			`CREATE INDEX IF NOT EXISTS sd_reviews_driver ON sd_reviews(driver_id, created_at)`,
			// Which quote request (EmDash "inquiries" entry) a booking was made from.
			`CREATE TABLE IF NOT EXISTS sd_inquiry_bookings (
				inquiry_id TEXT PRIMARY KEY,
				booking_code TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`,
			// Also created lazily by src/lib/members.ts; ops pages join it before any member page ran.
			`CREATE TABLE IF NOT EXISTS sd_member_requests (
				inquiry_id TEXT PRIMARY KEY,
				member_id TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`,
		],
	},
	{
		name: "0005_driver_app",
		statements: [
			// Sign-in for the driver app (/surucu): phone + a PIN that ops hands out.
			`CREATE TABLE IF NOT EXISTS sd_driver_access (
				driver_id TEXT PRIMARY KEY REFERENCES sd_drivers(id),
				pin_hash TEXT NOT NULL,
				failures INTEGER NOT NULL DEFAULT 0,
				locked_until TEXT,
				updated_at TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS sd_driver_sessions (
				token_hash TEXT PRIMARY KEY,
				driver_id TEXT NOT NULL REFERENCES sd_drivers(id),
				user_agent TEXT,
				created_at TEXT NOT NULL DEFAULT (${NOW}),
				expires_at TEXT NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS sd_driver_sessions_driver ON sd_driver_sessions(driver_id)`,
			// The driver's answer to an assignment. No row yet: waiting for the driver.
			`CREATE TABLE IF NOT EXISTS sd_assignment_acks (
				assignment_id TEXT PRIMARY KEY REFERENCES sd_assignments(id),
				response TEXT NOT NULL CHECK (response IN ('accepted','declined')),
				at TEXT NOT NULL
			)`,
		],
	},
	{
		name: "0006_driver_login_log",
		statements: [
			// Why each driver sign-in failed, for ops. Only the last four phone digits are kept.
			`CREATE TABLE IF NOT EXISTS sd_driver_login_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at TEXT NOT NULL,
				phone_tail TEXT NOT NULL,
				driver_id TEXT,
				result TEXT NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS sd_driver_login_log_at ON sd_driver_login_log(at)`,
		],
	},
	{
		name: "0007_driver_locations",
		statements: [
			// Each driver's latest position, sent from the driver app while a trip is under way.
			`CREATE TABLE IF NOT EXISTS sd_driver_locations (
				driver_id TEXT PRIMARY KEY REFERENCES sd_drivers(id),
				booking_id TEXT REFERENCES sd_bookings(id),
				lat REAL NOT NULL,
				lng REAL NOT NULL,
				accuracy REAL,
				heading REAL,
				speed REAL,
				at TEXT NOT NULL
			)`,
		],
	},
];
