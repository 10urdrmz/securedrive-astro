/**
 * The places a transfer request can be made between: the two Istanbul airports
 * and every district of the city except Adalar (the islands, not reachable by road).
 * Shared by the public form and the submit endpoint so both accept the same values.
 */
export const AIRPORTS = {
	IST: "İstanbul Havalimanı (IST)",
	SAW: "Sabiha Gökçen Havalimanı (SAW)",
} as const;
export type AirportCode = keyof typeof AIRPORTS;
export const AIRPORT_CODES = Object.keys(AIRPORTS) as AirportCode[];

export const DISTRICTS = [
	"Arnavutköy",
	"Ataşehir",
	"Avcılar",
	"Bağcılar",
	"Bahçelievler",
	"Bakırköy",
	"Başakşehir",
	"Bayrampaşa",
	"Beşiktaş",
	"Beykoz",
	"Beylikdüzü",
	"Beyoğlu",
	"Büyükçekmece",
	"Çatalca",
	"Çekmeköy",
	"Esenler",
	"Esenyurt",
	"Eyüpsultan",
	"Fatih",
	"Gaziosmanpaşa",
	"Güngören",
	"Kadıköy",
	"Kağıthane",
	"Kartal",
	"Küçükçekmece",
	"Maltepe",
	"Pendik",
	"Sancaktepe",
	"Sarıyer",
	"Silivri",
	"Sultanbeyli",
	"Sultangazi",
	"Şile",
	"Şişli",
	"Tuzla",
	"Ümraniye",
	"Üsküdar",
	"Zeytinburnu",
] as const;

/** Lower-cased and stripped of diacritics, so "Kâğıthane" and "Kagithane" compare equal. */
function fold(value: string): string {
	return value
		.toLocaleLowerCase("tr")
		.replaceAll("ı", "i")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.trim();
}

/** Airport code for "IST" or a label that carries it, e.g. "Istanbul Airport (IST)". */
export function matchAirport(value: unknown): AirportCode | undefined {
	if (typeof value !== "string") return undefined;
	return AIRPORT_CODES.find((code) => new RegExp(`\\b${code}\\b`).test(value.toUpperCase()));
}

/** District for its name or a route destination that starts with it, e.g. "Beyoğlu (Taksim)". */
export function matchDistrict(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const folded = fold(value);
	return DISTRICTS.find((district) => {
		const name = fold(district);
		return folded === name || folded.startsWith(`${name} `);
	});
}
