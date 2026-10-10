/** The site's languages. Turkish is the default and is served without a URL prefix. */
export const LOCALES = ["tr", "en", "ar", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "tr";

export const LOCALE_META: Record<Locale, { label: string; short: string; dir: "ltr" | "rtl"; og: string; intl: string }> = {
	tr: { label: "Türkçe", short: "TR", dir: "ltr", og: "tr_TR", intl: "tr-TR" },
	en: { label: "English", short: "EN", dir: "ltr", og: "en_GB", intl: "en-GB" },
	ar: { label: "العربية", short: "AR", dir: "rtl", og: "ar_AR", intl: "ar" },
	ru: { label: "Русский", short: "RU", dir: "ltr", og: "ru_RU", intl: "ru-RU" },
};

export function isLocale(value: string | undefined): value is Locale {
	return (LOCALES as readonly string[]).includes(value ?? "");
}

/**
 * Hand-built pages and their address. Every language uses the same Turkish
 * section names (the addresses the old site and search engines already know),
 * behind its language prefix: /filo, /en/filo, /ar/filo, /ru/filo.
 * Content entries live below their section, e.g. /hizmetler/havalimani-transferi.
 */
export const PAGE_SLUGS = {
	home: "",
	services: "hizmetler",
	fleet: "filo",
	routes: "rotalar",
	corporate: "kurumsal",
	faq: "sss",
	contact: "iletisim",
	about: "hakkimizda",
	how: "nasil-calisir",
	transfer: "transfer",
	blog: "blog",
} as const;

export type PageKey = keyof typeof PAGE_SLUGS;

/** Path prefix of a language: "" for Turkish, "/en" for English, and so on. */
export function localePrefix(locale: Locale): string {
	return locale === DEFAULT_LOCALE ? "" : `/${locale}`;
}

/** Address of a hand-built page (optionally with a child slug) in a language. */
export function pagePath(locale: Locale, key: PageKey, child?: string): string {
	return localizePath(locale, [PAGE_SLUGS[key], child].filter(Boolean).join("/"));
}

/** Put a language prefix in front of a site path ("filo" → "/en/filo"). */
export function localizePath(locale: Locale, path: string): string {
	const clean = path.replace(/^\/+/, "");
	return `${localePrefix(locale)}/${clean}`.replace(/\/$/, "") || "/";
}

/** Member pages live under /hesap: requests, profile ("profil"), password ("guvenlik"), sign-in ("giris") and sign-up ("uye-ol"). */
export const ACCOUNT_SLUG = "hesap";
export type AccountAction = "" | "profil" | "guvenlik" | "giris" | "uye-ol";

/** Address of a member page in a language. */
export function accountPath(locale: Locale, action: AccountAction = ""): string {
	return localizePath(locale, [ACCOUNT_SLUG, action].filter(Boolean).join("/"));
}

/** Every request has its own tracking page: /takip/<tracking id>. */
export const TRACK_SLUG = "takip";

/** Address of a request's tracking page in a language. */
export function trackPath(locale: Locale, trackingId: string): string {
	return localizePath(locale, `${TRACK_SLUG}/${trackingId.toLowerCase()}`);
}

/** Where visitors who are not signed in look up a request by its number and their phone or e-mail. */
export const LOOKUP_SLUG = "sorgula";

/** Address of the request lookup page in a language. */
export function lookupPath(locale: Locale): string {
	return localizePath(locale, LOOKUP_SLUG);
}

/** Find which hand-built page a slug belongs to. */
export function pageKeyForSlug(slug: string): PageKey | undefined {
	return (Object.keys(PAGE_SLUGS) as PageKey[]).find((key) => key !== "home" && PAGE_SLUGS[key] === slug);
}

/** Split a request path into its language and the remaining segments. */
export function parsePath(pathname: string): { locale: Locale; segments: string[] } {
	const segments = pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
	if (isLocale(segments[0]) && segments[0] !== DEFAULT_LOCALE) {
		return { locale: segments[0], segments: segments.slice(1) };
	}
	return { locale: DEFAULT_LOCALE, segments };
}

/**
 * Addresses of the old React site that people and search engines still use.
 * They redirect permanently to the new Turkish pages.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
	about: "/hakkimizda",
	"how-it-works": "/nasil-calisir",
	contact: "/iletisim",
	services: "/hizmetler",
	vehicles: "/filo",
	fleet: "/filo",
	routes: "/rotalar",
	faq: "/sss",
	terms: "/mesafeli-satis-sozlesmesi",
	privacy: "/gizlilik-politikasi",
	cancellation: "/iptal-ve-iade",
	home: "/",
	account: "/hesap",
	login: "/hesap/giris",
	register: "/hesap/uye-ol",
	passenger: "/",
	driver: "/",
	admin: "/_emdash/admin",
};
