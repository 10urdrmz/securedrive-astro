/**
 * Business facts shown across the site. Change them here; they are not content
 * an editor needs to touch day to day.
 *
 * TODO(Onur): the old site used two different numbers (0850 300 00 00 in the
 * header, +90 850 308 04 44 in the structured data). Confirm the real one.
 */
export const SITE = {
	url: "https://securedrive.org",
	name: "SecureDrive VIP",
	legalName: "SecureDrive VIP Transfer ve Taşımacılık",
	phone: "+908503080444",
	phoneDisplay: "+90 850 308 04 44",
	whatsapp: "908503080444",
	email: "operasyon@securedrive.org",
	licenses: {
		d2: "İST.U-NET.D2.34992",
		tursab: "12450",
	},
	geo: { lat: 41.0082, lng: 28.9784 },
	ogImage: "/images/fleet/vito-vip.webp",
} as const;

/**
 * Approximate exchange rates used only to show a "≈ €" hint next to TRY prices.
 * Quotes are always confirmed in writing by the operations team.
 */
export const DISPLAY_RATES = { EUR: 42.0, USD: 38.5, GBP: 49.0 } as const;

export const telHref = `tel:${SITE.phone}`;
export const whatsappHref = (text = "") =>
	`https://wa.me/${SITE.whatsapp}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
