import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { loadEnv } from "vite";
import { inquiriesPlugin } from "securedrive-inquiries";

const env = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
// Secrets stay out of the build: expose them to server code via process.env only.
// (On Cloudflare they come from Worker secrets instead; see wrangler.jsonc.)
for (const key of ["EMDASH_ENCRYPTION_KEY"]) {
	if (env[key] && !process.env[key]) process.env[key] = env[key];
}

// Local development runs on Node + SQLite + ./uploads.
// `npm run deploy` builds with EMDASH_TARGET=cloudflare for Workers + D1 + R2.
const onCloudflare = process.env.EMDASH_TARGET === "cloudflare";

/** Public pages served from the edge cache: fresh for 60 s, then stale while one request refreshes. */
const cachedPage = { maxAge: 60, swr: 86400 };

export default defineConfig({
	output: "server",
	adapter: onCloudflare ? cloudflare() : node({ mode: "standalone" }),
	site: "https://securedrive.org",
	i18n: {
		defaultLocale: "tr",
		locales: ["tr", "en", "ar", "ru"],
		// Untranslated content falls back: Arabic and Russian to English, English to Turkish.
		// No Astro-level fallback: it would re-render every 404 in Turkish. Content
		// falls back per entry instead (src/lib/content.ts).
		routing: { prefixDefaultLocale: false },
	},
	...(onCloudflare && {
		cache: { provider: cacheCloudflare() },
		routeRules: {
			"/": cachedPage,
			"/[...path]": cachedPage,
		},
	}),
	vite: { plugins: [tailwindcss()] },
	build: { inlineStylesheets: "always" },
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		// EmDash's admin UI is a React app; public pages ship no React.
		react(),
		emdash({
			// Passkeys are bound to this origin. Set EMDASH_SITE_URL at build time to
			// run the admin on another hostname (e.g. the workers.dev preview).
			...(onCloudflare && { siteUrl: env.EMDASH_SITE_URL || "https://securedrive.org" }),
			database: onCloudflare ? d1({ binding: "DB", session: "auto" }) : sqlite({ url: "file:./data.db" }),
			storage: onCloudflare
				? r2({ binding: "MEDIA" })
				: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
			// The admin carries the company's name and logo; its colours come from public/admin-theme.css.
			admin: {
				logo: "/logo.png",
				// Shown next to the logo in the sidebar and in the browser tab.
				siteName: "Yönetim Paneli",
				footerLabel: "SecureDrive",
				favicon: "/favicon.svg",
			},
			plugins: [inquiriesPlugin({ notifyEmail: env.INQUIRY_NOTIFY_EMAIL || undefined })],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			subsets: ["latin", "latin-ext", "cyrillic"],
			fallbacks: ["system-ui", "sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Outfit",
			cssVariable: "--font-heading",
			weights: [500, 600, 700, 800],
			subsets: ["latin", "latin-ext"],
			fallbacks: ["system-ui", "sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "IBM Plex Sans Arabic",
			cssVariable: "--font-arabic",
			weights: [400, 500, 600, 700],
			subsets: ["arabic"],
			fallbacks: ["system-ui", "sans-serif"],
		},
	],
	devToolbar: { enabled: false },
});
