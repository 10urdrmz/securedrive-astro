/**
 * Inquiries: the public forms of the site (transfer quote, contact, corporate application).
 *
 * POST /_emdash/api/plugins/inquiries/submit takes a JSON body and creates a DRAFT entry
 * in the "inquiries" collection, so every submission shows up in the admin for the
 * operations team. Nothing in that collection is ever rendered on the public site.
 *
 * When an email provider is configured (Settings → Email in the admin), each submission
 * is also sent to the operations address given in the plugin options.
 */
import { definePlugin, definePluginRoute } from "emdash";
import type { PluginDescriptor } from "emdash";

const PLUGIN_ID = "inquiries";
const VERSION = "0.1.0";
const COLLECTION = "inquiries";

/** Submissions accepted per visitor address in a rolling hour. */
const MAX_PER_HOUR = 8;
const KINDS = ["transfer", "contact", "corporate"] as const;
type Kind = (typeof KINDS)[number];

export interface InquiriesOptions {
	/** Where new submissions are emailed. Leave empty to only store them in the admin. */
	notifyEmail?: string;
}

export function inquiriesPlugin(options: InquiriesOptions = {}): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: VERSION,
		format: "native",
		entrypoint: "securedrive-inquiries",
		options,
	};
}

type Failure = { ok: false; error: string; message: string };
const fail = (error: string, message: string): Failure => ({ ok: false, error, message });

/** Trimmed single-line text, cut to `max` characters. */
function line(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Trimmed multi-line text, cut to `max` characters. */
function paragraph(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function count(value: unknown, max: number): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 && n <= max ? n : undefined;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const KIND_LABEL: Record<Kind, string> = {
	transfer: "Transfer talebi",
	contact: "İletişim mesajı",
	corporate: "Kurumsal başvuru",
};

export function createPlugin(options: InquiriesOptions = {}) {
	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: ["content:write", "email:send"],

		routes: {
			submit: definePluginRoute({
				public: true,
				methods: ["POST"],
				request: { body: "json", maxBytes: 16 * 1024 },
				handler: async (ctx) => {
					const input = (ctx.input ?? {}) as Record<string, unknown>;

					// Honeypot: real visitors never see or fill this field.
					if (line(input.website, 200)) return { ok: true };

					const kind = (KINDS as readonly string[]).includes(String(input.kind))
						? (input.kind as Kind)
						: null;
					if (!kind) return fail("INVALID_KIND", "Unknown form.");
					if (input.consent !== true) return fail("CONSENT_REQUIRED", "consent");

					const name = line(input.name, 80);
					const phone = line(input.phone, 24);
					const email = line(input.email, 120).toLowerCase();
					if (name.length < 2) return fail("NAME_REQUIRED", "name");
					if (!PHONE.test(phone)) return fail("PHONE_INVALID", "phone");
					if (email && !EMAIL.test(email)) return fail("EMAIL_INVALID", "email");

					const details: Record<string, unknown> = {};
					if (kind === "transfer") {
						details.from = line(input.from, 160);
						details.to = line(input.to, 160);
						details.date = DATE.test(String(input.date)) ? input.date : undefined;
						details.time = TIME.test(String(input.time)) ? input.time : undefined;
						details.passengers = count(input.passengers, 60);
						details.luggage = count(input.luggage, 60);
						details.vehicle = line(input.vehicle, 60) || undefined;
						details.flight = line(input.flight, 16).toUpperCase() || undefined;
						details.return_trip = input.return_trip === true;
						if (!details.from || !details.to) return fail("ROUTE_REQUIRED", "route");
						if (!details.date) return fail("DATE_REQUIRED", "date");
					}
					const company = line(input.company, 120);
					if (kind === "corporate" && !company) return fail("COMPANY_REQUIRED", "company");
					const message = paragraph(input.message, 3000);
					if (kind === "contact" && message.length < 5) return fail("MESSAGE_REQUIRED", "message");

					// Rate limit per visitor address. Only a short hash is stored, never the address itself.
					const visitor = await sha256(`${ctx.requestMeta?.ip ?? "unknown"}|${PLUGIN_ID}`);
					const bucket = `rate:${visitor}:${Math.floor(Date.now() / 3_600_000)}`;
					const used = (await ctx.kv.get<number>(bucket)) ?? 0;
					if (used >= MAX_PER_HOUR) return fail("RATE_LIMITED", "rate");
					await ctx.kv.set(bucket, used + 1);

					const submittedAt = new Date().toISOString();
					const route = kind === "transfer" ? `${details.from} → ${details.to}` : company;
					const title = [KIND_LABEL[kind], name, route].filter(Boolean).join(" · ");
					const locale = line(input.locale, 8) || "tr";

					await ctx.content!.create!(COLLECTION, {
						title,
						kind,
						status_label: "new",
						name,
						phone,
						email: email || undefined,
						company: company || undefined,
						message: message || undefined,
						details,
						form_locale: locale,
						submitted_at: submittedAt,
					});
					ctx.log.info("Inquiry received", { kind });

					const to = options.notifyEmail;
					if (to && ctx.email) {
						const lines = [
							`${KIND_LABEL[kind]} (${locale.toUpperCase()})`,
							"",
							`Ad: ${name}`,
							`Telefon: ${phone}`,
							email && `E-posta: ${email}`,
							company && `Firma: ${company}`,
							...Object.entries(details)
								.filter(([, v]) => v !== undefined && v !== "" && v !== false)
								.map(([k, v]) => `${k}: ${v}`),
							message && `\n${message}`,
						].filter(Boolean);
						try {
							await ctx.email.send({
								to,
								replyTo: email || undefined,
								subject: `[SecureDrive] ${title}`,
								text: lines.join("\n"),
							});
						} catch (error) {
							// The entry is already saved; a mail failure must not fail the visitor's form.
							ctx.log.warn("Inquiry email failed", { error: String(error) });
						}
					}
					return { ok: true };
				},
			}),
		},
	});
}

export default createPlugin;
