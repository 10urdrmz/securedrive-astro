import { LOCALE_META, type Locale } from "../i18n/locales";
import { DISPLAY_RATES } from "./site";

/** "₺1.750" in Turkish, "TRY 1,750" style in other languages. */
export function formatTry(amount: number, locale: Locale): string {
	return new Intl.NumberFormat(LOCALE_META[locale].intl, {
		style: "currency",
		currency: "TRY",
		maximumFractionDigits: 0,
	}).format(amount);
}

/** The euro hint shown under a TRY price; most visitors from abroad think in euros. */
export function formatApprox(amountTry: number, locale: Locale): string {
	return new Intl.NumberFormat(LOCALE_META[locale].intl, {
		style: "currency",
		currency: "EUR",
		maximumFractionDigits: 0,
	}).format(Math.round(amountTry / DISPLAY_RATES.EUR));
}

export function formatDate(date: Date, locale: Locale): string {
	return new Intl.DateTimeFormat(LOCALE_META[locale].intl, { dateStyle: "long" }).format(date);
}
