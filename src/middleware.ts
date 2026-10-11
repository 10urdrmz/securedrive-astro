import { defineMiddleware } from "astro:middleware";
import { getDb } from "./server/db";
import { PRIVATE_PATH, purgeEdgeCacheOnce } from "./server/edge-cache";
import { dispatchIfDue } from "./server/dispatch";
import { refreshFlightsIfDue } from "./server/flights";

/**
 * Adds the SecureDrive theme to the EmDash admin.
 *
 * The admin is a ready-made app with its own stylesheet and no setting for extra
 * CSS, so its pages get one more <link> on the way out. The theme itself lives
 * in public/admin-theme.css; bump the version below when it changes so browsers
 * fetch the new file.
 */
const THEME = '<link rel="stylesheet" href="/admin-theme.css?v=3">';

/** Cross-site form posts we expect: payment providers returning the passenger to us. */
const CROSS_SITE_POST_ALLOWED = ["/api/odeme/iyzico"];
const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

/**
 * Astro's own same-origin check for form posts (security.checkOrigin), with one
 * difference: the payment callbacks above may be posted from the provider's page.
 * Mirrors astro/dist/core/app/origin-check.js.
 */
function forbiddenCrossSite(request: Request, url: URL): boolean {
	if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
	if (CROSS_SITE_POST_ALLOWED.includes(url.pathname)) return false;
	const type = request.headers.get("content-type");
	if (type && !FORM_TYPES.some((t) => type.toLowerCase().includes(t))) return false;
	const site = request.headers.get("sec-fetch-site");
	if (site) return site !== "same-origin" && site !== "none";
	const origin = request.headers.get("origin");
	return !!origin && origin !== url.origin;
}

export const onRequest = defineMiddleware(async (context, next) => {
	if (forbiddenCrossSite(context.request, context.url)) {
		return new Response("Cross-site POST form submissions are forbidden", { status: 403 });
	}
	// Personal pages (and their redirects and 404s) never go to the edge cache.
	if (PRIVATE_PATH.test(context.url.pathname)) {
		if (context.cache?.enabled) context.cache.set(false);
		if (import.meta.env.PROD) await purgeEdgeCacheOnce(await getDb(context.locals));
		// Automatic driver offers move on while ops or drivers have the panels open.
		if (/^\/(?:ops|surucu)(?:\/|$)/.test(context.url.pathname)) await dispatchIfDue(await getDb(context.locals));
		// Flight status stays fresh while anyone follows a booking.
		// On Cloudflare the check runs after the response, so nobody waits for the flight API.
		if (/^\/(?:ops|surucu|(?:[a-z]{2}\/)?rezervasyon\/)/.test(context.url.pathname)) {
			const task = refreshFlightsIfDue(await getDb(context.locals));
			const cf = (context.locals as { cfContext?: { waitUntil(promise: Promise<unknown>): void } }).cfContext;
			if (cf) cf.waitUntil(task);
			else await task;
		}
	}
	const response = await next();
	if (!context.url.pathname.startsWith("/_emdash/admin")) return response;
	if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;

	const html = await response.text();
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(html.replace("</head>", `${THEME}</head>`), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
});
