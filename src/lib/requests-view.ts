import { LOCALE_META, type Locale } from "../i18n/locales";
import type { MemberRequest } from "./members";
import { airportName } from "./routes";
import { matchAirport } from "securedrive-inquiries/places";
import { inquiryReference } from "securedrive-inquiries/reference";

/** A request with its texts ready for display in one language. */
export function presentRequest(request: MemberRequest, locale: Locale) {
	const intl = LOCALE_META[locale].intl;
	const airport = matchAirport(request.from);
	return {
		...request,
		reference: inquiryReference(request.id, request.reference),
		from: airport ? airportName(airport, locale) : request.from,
		// Travel dates are plain calendar days; format them without shifting time zones.
		day: request.date
			? new Date(`${request.date}T00:00:00Z`).toLocaleDateString(intl, { dateStyle: "long", timeZone: "UTC" })
			: "",
		sent: new Date(request.submittedAt).toLocaleDateString(intl, { dateStyle: "medium" }),
	};
}
