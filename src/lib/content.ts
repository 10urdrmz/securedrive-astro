import type { AstroGlobal } from "astro";
import { getEmDashCollection, getEmDashEntry } from "emdash";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";

/** Languages to try for content, most preferred first (mirrors the i18n fallback in astro.config.mjs). */
export function fallbackChain(locale: Locale): Locale[] {
	if (locale === "tr") return ["tr"];
	if (locale === "en") return ["en", "tr"];
	return [locale, "en", "tr"];
}

/** Entry slug without any language prefix the loader may add ("en/about" → "about"). */
export function slugOf(entry: { id: string }): string {
	return entry.id.split("/").pop() ?? entry.id;
}

type CacheHint = Parameters<NonNullable<AstroGlobal["cache"]>["set"]>[0];

function remember(Astro: AstroGlobal, hint: CacheHint | undefined) {
	if (hint && Astro.cache?.enabled) Astro.cache.set(hint);
}

/**
 * Every published entry of a collection in the visitor's language. Entries that
 * have not been translated yet appear in the nearest fallback language, so a list
 * never comes up short on an Arabic or Russian page.
 */
export async function getLocalized<T extends string>(Astro: AstroGlobal, collection: T, locale: Locale) {
	const chain = fallbackChain(locale);
	const results = await Promise.all(
		chain.map((l) => getEmDashCollection(collection, { locale: l, limit: 500 })),
	);
	const bySlug = new Map<string, (typeof results)[number]["entries"][number]>();
	for (const result of results) {
		remember(Astro, result.cacheHint);
		for (const entry of result.entries) {
			const slug = slugOf(entry);
			if (!bySlug.has(slug)) bySlug.set(slug, entry);
		}
	}
	// Keep the order of the default language, which is the complete list.
	const base = results.at(-1)?.entries ?? [];
	const ordered = base.map((e) => bySlug.get(slugOf(e))!).filter(Boolean);
	for (const [slug, entry] of bySlug) if (!base.some((e) => slugOf(e) === slug)) ordered.push(entry);
	return ordered;
}

/** One entry in the visitor's language, falling back like the lists do. */
export async function getLocalizedEntry<T extends string>(Astro: AstroGlobal, collection: T, slug: string, locale: Locale) {
	const result = await getEmDashEntry(collection, slug, { locale });
	remember(Astro, result.cacheHint);
	if (result.entry) return result.entry;
	if (locale === DEFAULT_LOCALE) return null;
	for (const l of fallbackChain(locale).slice(1)) {
		const fallback = await getEmDashEntry(collection, slug, { locale: l });
		remember(Astro, fallback.cacheHint);
		if (fallback.entry) return fallback.entry;
	}
	return null;
}

export function byOrder<T extends { data: { order?: number | null } }>(a: T, b: T): number {
	return (a.data.order ?? 99) - (b.data.order ?? 99);
}

/** Plain strings from a repeater of `{ text }` rows. */
export function texts(rows: unknown): string[] {
	if (!Array.isArray(rows)) return [];
	return rows.map((r) => (r && typeof r === "object" && "text" in r ? String(r.text) : "")).filter(Boolean);
}

/** Image URL of an EmDash image field, or the static fallback path. */
export function imageUrl(image: unknown, fallback?: string | null): string | null {
	if (image && typeof image === "object" && "src" in image && typeof image.src === "string" && image.src) return image.src;
	return fallback || null;
}
