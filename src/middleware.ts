import { defineMiddleware } from "astro:middleware";

/**
 * Adds the SecureDrive theme to the EmDash admin.
 *
 * The admin is a ready-made app with its own stylesheet and no setting for extra
 * CSS, so its pages get one more <link> on the way out. The theme itself lives
 * in public/admin-theme.css; bump the version below when it changes so browsers
 * fetch the new file.
 */
const THEME = '<link rel="stylesheet" href="/admin-theme.css?v=3">';

export const onRequest = defineMiddleware(async (context, next) => {
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
