/**
 * Database access for the business layer.
 *
 * We reuse EmDash's Kysely instance (D1 on Cloudflare, SQLite locally), so there is one
 * connection and one database. Our tables are plain sd_* tables queried with Kysely;
 * we never touch EmDash's own tables.
 */
import { getDb as getEmDashDb } from "emdash/runtime";
import { sql, type Kysely } from "kysely";
import { MIGRATIONS } from "./migrations";

// Rows are typed per query; the database itself is untyped to keep EmDash's schema out.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = Kysely<any>;

let ready: Promise<void> | null = null;

/** The request's database, with our schema guaranteed to be up to date. */
export async function getDb(locals: App.Locals): Promise<Db> {
	// locals.emdash is only populated on admin routes; elsewhere EmDash's own getDb()
	// returns the request-scoped (D1 replica-aware) or shared instance.
	const db = ((locals.emdash?.db as unknown) ?? (await getEmDashDb())) as Db;
	// Once per isolate. A failure is not cached, so the next request retries.
	ready ??= migrate(db).catch((error) => {
		ready = null;
		throw error;
	});
	await ready;
	return db;
}

async function migrate(db: Db): Promise<void> {
	await sql`CREATE TABLE IF NOT EXISTS sd_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`.execute(db);
	const done = await db.selectFrom("sd_migrations").select("name").execute();
	const applied = new Set(done.map((row: { name: string }) => row.name));
	for (const migration of MIGRATIONS) {
		if (applied.has(migration.name)) continue;
		for (const statement of migration.statements) await sql.raw(statement).execute(db);
		await sql`INSERT OR IGNORE INTO sd_migrations (name, applied_at) VALUES (${migration.name}, ${new Date().toISOString()})`.execute(db);
	}
}

export const nowIso = () => new Date().toISOString();
