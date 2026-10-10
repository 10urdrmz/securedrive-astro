import type { APIRoute } from "astro";
import { SITE } from "../lib/site";

export const GET: APIRoute = () =>
	new Response(`User-agent: *\nAllow: /\nDisallow: /_emdash/\nDisallow: /hesap\nDisallow: /*/hesap\nDisallow: /takip\nDisallow: /*/takip\nDisallow: /sorgula\nDisallow: /*/sorgula\n\nSitemap: ${SITE.url}/sitemap.xml\n`, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
