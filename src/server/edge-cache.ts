/**
 * Keeps personal pages out of the Cloudflare edge cache.
 *
 * astro.config.mjs caches every route for 60 s ("/[...path]") because most of the
 * site is public content. Signed-in panels, booking pages and APIs must never be
 * cached: their responses (and even their sign-in redirects and 404s) differ per
 * visitor. src/middleware.ts switches the cache off for them before anything renders.
 */
import type { Db } from "./db";

/** Panels, personal pages and endpoints, in every language. */
export const PRIVATE_PATH = /^\/(?:(?:en|ar|ru)\/)?(?:ops|surucu|partner|hesap|rezervasyon|sorgula|api)(?:\/|\.|$)|^\/_emdash(?:\/|$)/;

const PURGE_KEY = "edge_cache_purged_v1";
// A flag, not a shared promise: on Workers a promise started by one request never
// settles if that request is cancelled, and every later request awaiting it would hang.
let purged = false;

/**
 * One-time purge of everything the edge cached before private paths were excluded.
 * Claimed through sd_settings so only one isolate, once, does it. Public pages simply
 * re-render on their next request.
 */
export async function purgeEdgeCacheOnce(db: Db): Promise<void> {
	if (purged) return;
	try {
		const mark = `${new Date().toISOString()}#${Math.random().toString(36).slice(2)}`;
		await db
			.insertInto("sd_settings")
			.values({ key: PURGE_KEY, value: mark })
			.onConflict((oc) => oc.column("key").doNothing())
			.execute();
		const row = await db.selectFrom("sd_settings").select("value").where("key", "=", PURGE_KEY).executeTakeFirst();
		if (row?.value !== mark) {
			purged = true;
			return;
		}
		try {
			const specifier = "cloudflare:workers";
			const { cache } = (await import(/* @vite-ignore */ specifier)) as { cache?: { purge(o: { purgeEverything: boolean }): Promise<{ success: boolean }> } };
			const result = await cache?.purge({ purgeEverything: true });
			if (!result?.success) throw new Error("purge failed");
			purged = true;
		} catch (error) {
			// Not on Cloudflare (local Node) or the purge failed: release the claim to retry later.
			await db.deleteFrom("sd_settings").where("key", "=", PURGE_KEY).execute();
			if (!(error instanceof Error && /cloudflare:workers|Cannot find|resolve/i.test(error.message))) console.error("edge cache purge", error);
		}
	} catch {
		// Database busy or unavailable: try again on a later request.
	}
}
