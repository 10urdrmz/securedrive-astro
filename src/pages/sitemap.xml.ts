import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";
import { LOCALES, PAGE_SLUGS, localizePath, type Locale } from "../i18n/locales";
import { slugOf } from "../lib/content";
import { SITE } from "../lib/site";

/**
 * Every public URL in every language, with hreflang alternates. Hand-built
 * sections exist in all languages; collection entries are listed in all
 * languages too, because untranslated ones render in the fallback language.
 */
export const GET: APIRoute = async () => {
	const paths = new Set<string>(Object.values(PAGE_SLUGS));
	paths.delete(PAGE_SLUGS.about); // listed through the pages collection below

	const sections = { services: PAGE_SLUGS.services, vehicles: PAGE_SLUGS.fleet, routes: PAGE_SLUGS.routes, posts: PAGE_SLUGS.blog };
	for (const [collection, base] of Object.entries(sections)) {
		const { entries } = await getEmDashCollection(collection, { locale: "tr", limit: 1000 });
		for (const e of entries) paths.add(`${base}/${slugOf(e)}`);
	}
	const { entries: pages } = await getEmDashCollection("pages", { locale: "tr", limit: 1000 });
	for (const p of pages) if (slugOf(p) !== "home") paths.add(slugOf(p));

	const url = (l: Locale, path: string) => new URL(localizePath(l, path), SITE.url).href;
	const body = [...paths]
		.flatMap((path) =>
			LOCALES.map(
				(l) =>
					`<url><loc>${url(l, path)}</loc>${LOCALES.map((a) => `<xhtml:link rel="alternate" hreflang="${a}" href="${url(a, path)}"/>`).join("")}<xhtml:link rel="alternate" hreflang="x-default" href="${url("tr", path)}"/></url>`,
			),
		)
		.join("\n");

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${body}\n</urlset>\n`,
		{ headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
	);
};
