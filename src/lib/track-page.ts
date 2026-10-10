import type { AstroGlobal } from "astro";
import { accountPath, lookupPath, trackPath, type Locale } from "../i18n/locales";
import type { UiKey } from "../i18n/ui";
import { NO_STORE } from "./account-page";
import { currentMember, lookupRequest, trackedRequest, type MemberRequest } from "./members";

/**
 * Load a request's tracking page. A signed-in member goes straight to their own
 * request; a member opening someone else's link gets "not found". Visitors who
 * are not signed in are sent to the lookup page, where the request number plus
 * their phone or e-mail opens it.
 */
export async function runTrackPage(Astro: AstroGlobal, locale: Locale, trackingId: string): Promise<Response | MemberRequest | null> {
	// A request's status changes and the page is personal; never serve it from a cache.
	Astro.cache?.set(false);
	Astro.response.headers.set("Cache-Control", NO_STORE);

	const member = await currentMember(Astro);
	if (!member) {
		const next = encodeURIComponent(trackPath(locale, trackingId));
		const response = Astro.redirect(`${lookupPath(locale)}?next=${next}`, 303);
		response.headers.set("Cache-Control", NO_STORE);
		return response;
	}
	const request = await trackedRequest(trackingId, member);
	if (!request) Astro.response.status = 404;
	return request;
}

/** A `next` address is honoured only when it is one of our own tracking pages. */
export function safeNext(value: string | null | undefined): string | undefined {
	return value && /^\/(?:(?:en|ar|ru)\/)?takip\/[0-9a-z]{26}$/.test(value) ? value : undefined;
}

export interface LookupPage {
	locale: Locale;
	/** The request that matched, once the form has been answered correctly. */
	request: MemberRequest | null;
	error?: UiKey;
	/** What the visitor typed, to refill the form. */
	values: { reference: string; contact: string };
	/** The tracking page the visitor came from, offered again behind "sign in". */
	next?: string;
}

/**
 * The lookup page (/sorgula). Signed-in members have nothing to look up and go
 * to their requests; everyone else gets the form, and on a match the request is
 * shown in the same response (there is no address to bookmark or leak).
 */
export async function runLookupPage(Astro: AstroGlobal, locale: Locale): Promise<Response | LookupPage> {
	Astro.cache?.set(false);
	Astro.response.headers.set("Cache-Control", NO_STORE);
	const redirect = (target: string) => {
		const response = Astro.redirect(target, 303);
		response.headers.set("Cache-Control", NO_STORE);
		return response;
	};

	const params = Astro.url.searchParams;
	const next = safeNext(params.get("next"));
	if (await currentMember(Astro)) return redirect(next ?? accountPath(locale));

	const page: LookupPage = { locale, request: null, values: { reference: (params.get("no") ?? "").slice(0, 24), contact: "" }, next };
	if (Astro.request.method !== "POST") return page;

	// The form may only be posted from our own pages.
	if (Astro.request.headers.get("origin") !== Astro.url.origin) {
		return new Response("Forbidden", { status: 403, headers: { "Cache-Control": NO_STORE } });
	}
	const form = await Astro.request.formData();
	const field = (name: string) => {
		const value = form.get(name);
		return typeof value === "string" ? value : "";
	};
	page.values = { reference: field("reference").slice(0, 24), contact: field("contact").slice(0, 120) };
	page.next = safeNext(field("next"));

	const result = await lookupRequest(Astro, field("reference"), field("contact"));
	if (!result.ok) {
		Astro.response.status = result.error === "rate" ? 429 : 422;
		page.error = result.error === "rate" ? "account.error.rate" : "lookup.error";
		return page;
	}
	page.request = result.request;
	return page;
}
