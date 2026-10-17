/**
 * Nationalities offered on the booking form, most common guests first. Names come from
 * Intl.DisplayNames in the visitor's language; "XX" stands for any other country.
 */
export const NATIONALITIES = [
	"TR", "DE", "GB", "SA", "AE", "QA", "KW", "IQ", "IR", "AZ", "RU", "UA", "KZ", "US", "FR", "NL", "IT", "ES", "GR", "EG", "JO", "LB", "IL", "CN", "IN", "XX",
] as const;

export function nationalityName(code: string, intl: string, other: string): string {
	if (code === "XX") return other;
	try {
		return new Intl.DisplayNames([intl], { type: "region" }).of(code) ?? code;
	} catch {
		return code;
	}
}
