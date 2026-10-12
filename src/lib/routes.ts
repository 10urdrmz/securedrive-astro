import { bookPath, type Locale } from "../i18n/locales";
import { ISTANBUL_DISTRICTS } from "../server/db/catalog";

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

const fold = (s: string) => s.trim().toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");

/**
 * The booking zone id for an airport code ("IST") or a district name ("Beşiktaş"), so
 * links from route pages and the homepage can open /rezervasyon with the trip filled in.
 */
export function zoneIdOf(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const code = value.trim().toUpperCase().match(/\b(IST|SAW)\b/)?.[1];
	if (code) return code.toLowerCase();
	const wanted = fold(value);
	return ISTANBUL_DISTRICTS.find((d) => d.serviceable && (d.id === wanted || fold(d.name) === wanted))?.id;
}

/** /rezervasyon with whatever part of the trip is known. */
export function bookHref(locale: Locale, trip: { from?: string | null; to?: string | null; date?: string | null; pax?: string | number | null }): string {
	const params = new URLSearchParams();
	const from = zoneIdOf(trip.from);
	const to = zoneIdOf(trip.to);
	if (from) params.set("from", from);
	if (to) params.set("to", to);
	if (trip.date && /^\d{4}-\d{2}-\d{2}$/.test(trip.date)) params.set("date", trip.date);
	const pax = Number(trip.pax);
	if (pax >= 1 && pax <= 60) params.set("pax", String(Math.round(pax)));
	const query = params.toString();
	return query ? `${bookPath(locale)}?${query}` : bookPath(locale);
}
