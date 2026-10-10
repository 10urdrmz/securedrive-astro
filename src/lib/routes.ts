import type { Locale } from "../i18n/locales";

const AIRPORTS: Record<string, Record<Locale, string>> = {
	IST: { tr: "İstanbul Havalimanı", en: "Istanbul Airport", ar: "مطار إسطنبول", ru: "Аэропорт Стамбула" },
	SAW: { tr: "Sabiha Gökçen Havalimanı", en: "Sabiha Gökçen Airport", ar: "مطار صبيحة كوكجن", ru: "Аэропорт Сабиха Гёкчен" },
};

/** "Istanbul Airport (IST)" in the visitor's language. */
export function airportName(code: string, locale: Locale): string {
	const name = AIRPORTS[code]?.[locale];
	return name ? `${name} (${code})` : code;
}

/**
 * Route titles in the CMS are written in Turkish; other languages build theirs
 * from the airport and district so all 77 routes read naturally without
 * needing a translation each.
 */
export function routeTitle(data: { title: string; origin: string; destination: string }, locale: Locale): string {
	if (locale === "tr") return data.title;
	return `${airportName(data.origin, locale)} → ${data.destination}`;
}
