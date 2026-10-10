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
];
