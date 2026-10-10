SecureDrive VIP: the public website and CMS for an Istanbul VIP transfer company.
Built on Astro 7 + EmDash CMS. Production runs on Cloudflare Workers (D1 + R2);
local development uses Node + SQLite.

## Commands

```bash
npm run dev        # Dev server (Node + SQLite at ./data.db, media in ./uploads)
npm run seed       # Apply seed/seed.json (schema + starter content) to ./data.db
npm run build      # Node build
npm run build:cf   # Cloudflare build (EMDASH_TARGET=cloudflare)
npm run deploy     # Cloudflare build + wrangler deploy
```

Admin UI: `http://localhost:4321/_emdash/admin` (dev bypass link is printed on start).

## Languages

- `tr` (default, no prefix), `en`, `ar` (RTL), `ru`. Section slugs are Turkish in
  every language: `/hizmetler`, `/en/hizmetler`, `/ar/filo/…`.
- UI strings live in `src/i18n/ui.ts`; every key must exist in all four dictionaries.
- Content falls back per entry: `ar`/`ru` → `en` → `tr` (`src/lib/content.ts`).
  Astro's own i18n `fallback` is deliberately off: it re-renders 404s in Turkish.
- Route titles are Turkish in the CMS; other languages build them in `src/lib/routes.ts`.

## Structure

| Path | Purpose |
| --- | --- |
| `src/pages/[...path].astro` | The only page route. Parses language, handles legacy 301s, picks a view, 404s unknown entries |
| `src/views/*.astro` | One component per page type (HomeView, RouteView, …) |
| `src/components/` | Header, Footer, InquiryForm, ContactDock, `sections/` cards and blocks |
| `src/i18n/locales.ts` | Locales, section slugs, `pagePath()`, `localizePath()`, legacy redirects |
| `src/lib/site.ts` | Business facts (phone, email, licences, display FX rates) |
| `src/lib/schema.ts` | JSON-LD builders |
| `src/pages/sitemap.xml.ts`, `robots.txt.ts` | SEO endpoints |
| `plugins/inquiries/` | Native EmDash plugin: public form endpoint → draft entries in `inquiries` |
| `seed/seed.json` | Collections, fields and starter content |

## Rules

- Public pages ship no framework JS. React is only for the EmDash admin.
- Hand-built pages pass `path` (unprefixed) to `Base`; content pages also pass
  `content={{ collection, id: entry.data.id, slug }}` so EmDash emits SEO + hreflang.
- `entry.id` may carry a locale prefix; always use `slugOf(entry)`.
- Image fields are objects; render through `components/Photo.astro`.
- The `inquiries` collection holds personal data. Never publish its entries and
  never query it from a public page.

## Docs

EmDash docs MCP server: `https://docs.emdashcms.com/mcp`. Skills are in `.agents/skills/`.
