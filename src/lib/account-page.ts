/**
 * Request handling for the member pages (/hesap, /hesap/giris, /hesap/uye-ol).
 *
 * The page files call `runAccountPage` and either return its redirect or render
 * `AccountView` with the result. Every form posts back to its own address and a
 * successful action redirects, so reloading never resubmits.
 */
import type { AstroGlobal } from "astro";
import { accountPath, type AccountAction, type Locale } from "../i18n/locales";
import type { UiKey } from "../i18n/ui";
import {
	authenticate,
	changePassword,
	currentMember,
	endSession,
	memberRequests,
	registerMember,
	startSession,
	updateProfile,
	type Member,
	type MemberRequest,
} from "./members";
import { safeNext } from "./track-page";
import { memberBookingCards, type BookingCard } from "./booking-page";

export type AccountNotice = "welcome" | "saved" | "passwordChanged";
const NOTICES: readonly AccountNotice[] = ["welcome", "saved", "passwordChanged"];

export interface AccountPage {
	/** "account" lists the member's requests; "profile" and "security" are its two settings pages. */
	view: "login" | "register" | "account" | "profile" | "security";
	locale: Locale;
	member: Member | null;
	/** Translation key of the message to show above the form that failed. */
	error?: UiKey;
	/** Which form on the account page the error belongs to. */
	errorForm?: "profile" | "password";
	notice?: AccountNotice;
	/** The member's own transfer requests, newest first (account page only). */
	requests: MemberRequest[];
	/** The member's online bookings, newest pickup first (account page only). */
	bookings: BookingCard[];
	/** What the visitor typed, to refill the form after an error. Never holds a password. */
	values: Record<string, string>;
}

export const NO_STORE = "private, no-store";

const VIEWS: Record<string, AccountPage["view"]> = {
	"": "account",
	profil: "profile",
	guvenlik: "security",
	giris: "login",
	"uye-ol": "register",
};

export async function runAccountPage(Astro: AstroGlobal, locale: Locale, action: string): Promise<Response | AccountPage | null> {
	const view = VIEWS[action];
	if (!view) return null;

	// Member pages are personal: keep them, and their redirects, out of every cache.
	// The site's route rules would otherwise store them at the edge for all visitors.
	Astro.cache?.set(false);
	Astro.response.headers.set("Cache-Control", NO_STORE);
	const to = (target: AccountAction, query = "") => {
		const response = Astro.redirect(accountPath(locale, target) + query, 303);
		response.headers.set("Cache-Control", NO_STORE);
		return response;
	};
	const errorKey = (name: string) => `account.error.${name}` as UiKey;

	const member = await currentMember(Astro);
	const page: AccountPage = { view, locale, member, requests: [], bookings: [], values: {} };
	if (view === "account" && member) {
		[page.requests, page.bookings] = await Promise.all([memberRequests(member), memberBookingCards(Astro, member)]);
	}

	const guestView = view === "login" || view === "register";
	if (Astro.request.method !== "POST") {
		if (!guestView && !member) return to("giris");
		if (guestView && member) return to("");
		const notice = Astro.url.searchParams.get("ok") as AccountNotice | null;
		if (!guestView && notice && NOTICES.includes(notice)) page.notice = notice;
		if (view === "login") page.values = { next: safeNext(Astro.url.searchParams.get("next")) ?? "" };
		return page;
	}

	// Forms may only be posted from our own pages.
	if (Astro.request.headers.get("origin") !== Astro.url.origin) {
		return new Response("Forbidden", { status: 403, headers: { "Cache-Control": NO_STORE } });
	}
	const form = await Astro.request.formData();
	const field = (name: string) => {
		const value = form.get(name);
		return typeof value === "string" ? value : "";
	};
	const fail = (error: string, errorForm?: AccountPage["errorForm"]) => {
		Astro.response.status = error === "rate" ? 429 : 422;
		return { ...page, error: errorKey(error), errorForm };
	};

	if (view === "login") {
		page.values = { identifier: field("identifier").slice(0, 120), next: safeNext(field("next")) ?? "" };
		const result = await authenticate(Astro, field("identifier"), field("password"));
		if (!result.ok) return fail(result.error);
		await startSession(Astro, result.member.id);
		// Came here from a tracking link: go back to it.
		const next = safeNext(field("next"));
		if (next) {
			const response = Astro.redirect(next, 303);
			response.headers.set("Cache-Control", NO_STORE);
			return response;
		}
		return to("");
	}

	if (view === "register") {
		page.values = {
			name: field("name").slice(0, 80),
			username: field("username").slice(0, 40),
			email: field("email").slice(0, 120),
			phone: field("phone").slice(0, 24),
		};
		// Honeypot: real visitors never see or fill this field.
		if (field("website")) return to("giris");
		const result = await registerMember(Astro, {
			name: field("name"),
			username: field("username"),
			email: field("email"),
			phone: field("phone"),
			password: field("password"),
			passwordRepeat: field("password_repeat"),
			consent: field("consent") === "on",
			locale,
		});
		if (!result.ok) return fail(result.error);
		await startSession(Astro, result.member.id);
		return to("", "?ok=welcome");
	}

	if (!member) return to("giris");
	const intent = field("intent");
	if (intent === "logout") {
		await endSession(Astro);
		return to("giris");
	}
	if (intent === "profile") {
		page.values = { name: field("name").slice(0, 80), email: field("email").slice(0, 120), phone: field("phone").slice(0, 24) };
		const result = await updateProfile(member, { name: field("name"), email: field("email"), phone: field("phone") });
		if (!result.ok) return fail(result.error, "profile");
		return to("profil", "?ok=saved");
	}
	if (intent === "password") {
		const result = await changePassword(Astro, member, {
			current: field("current_password"),
			next: field("password"),
			repeat: field("password_repeat"),
		});
		if (!result.ok) return fail(result.error, "password");
		return to("guvenlik", "?ok=passwordChanged");
	}
	return to("");
}
