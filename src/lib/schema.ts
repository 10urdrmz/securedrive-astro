import { LOCALE_META, localizePath, type Locale } from "../i18n/locales";
import { SITE } from "./site";

/** The business itself, as structured data for search engines. */
export function businessJsonLd(locale: Locale, description: string) {
	return {
		"@context": "https://schema.org",
		"@type": ["TaxiService", "LocalBusiness"],
		"@id": `${SITE.url}/#business`,
		name: SITE.name,
		url: new URL(localizePath(locale, ""), SITE.url).href,
		logo: `${SITE.url}/logo.png`,
		image: new URL(SITE.ogImage, SITE.url).href,
		description,
		telephone: SITE.phone,
		email: SITE.email,
		priceRange: "₺₺₺",
		inLanguage: LOCALE_META[locale].intl,
		address: { "@type": "PostalAddress", addressLocality: "İstanbul", addressCountry: "TR" },
		geo: { "@type": "GeoCoordinates", latitude: SITE.geo.lat, longitude: SITE.geo.lng },
		areaServed: { "@type": "City", name: "İstanbul" },
		openingHoursSpecification: {
			"@type": "OpeningHoursSpecification",
			dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
			opens: "00:00",
			closes: "23:59",
		},
	};
}

export function faqJsonLd(items: { question: string; answer: string }[]) {
	return {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: items.map((item) => ({
			"@type": "Question",
			name: item.question,
			acceptedAnswer: { "@type": "Answer", text: item.answer },
		})),
	};
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
	return {
		"@context": "https://schema.org",
		"@type": "BreadcrumbList",
		itemListElement: items.map((item, i) => ({
			"@type": "ListItem",
			position: i + 1,
			name: item.name,
			item: new URL(item.path, SITE.url).href,
		})),
	};
}
