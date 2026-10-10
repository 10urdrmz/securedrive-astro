/**
 * iyzico Checkout Form (hosted payment page). We never see card data: the passenger is
 * sent to iyzico's page, pays with 3D Secure, and comes back to our callback with a
 * token. The callback asks iyzico, server to server, what happened to that token;
 * nothing the browser posts is trusted.
 *
 * Configuration (Worker secrets, or the shell environment locally):
 *   IYZICO_API_KEY, IYZICO_SECRET_KEY   merchant keys from the iyzico panel
 *   IYZICO_BASE_URL                     https://api.iyzipay.com in production;
 *                                       defaults to the sandbox
 * Without keys online payment is simply not offered.
 */

const SANDBOX = "https://sandbox-api.iyzipay.com";

interface Config {
	apiKey: string;
	secretKey: string;
	baseUrl: string;
}

function config(): Config | null {
	const apiKey = process.env.IYZICO_API_KEY ?? "";
	const secretKey = process.env.IYZICO_SECRET_KEY ?? "";
	if (!apiKey || !secretKey) return null;
	return { apiKey, secretKey, baseUrl: (process.env.IYZICO_BASE_URL || SANDBOX).replace(/\/+$/, "") };
}

export function iyzicoEnabled(): boolean {
	return config() !== null;
}

export function iyzicoIsSandbox(): boolean {
	return (config()?.baseUrl ?? SANDBOX).includes("sandbox");
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** IYZWSv2 header: HMAC-SHA256 over random key + path + body, keyed with the secret. */
async function authHeaders(cfg: Config, path: string, body: string): Promise<Record<string, string>> {
	const randomKey = `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(cfg.secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(randomKey + path + body)));
	const authorization = btoa(`apiKey:${cfg.apiKey}&randomKey:${randomKey}&signature:${signature}`);
	return {
		Authorization: `IYZWSv2 ${authorization}`,
		"x-iyzi-rnd": randomKey,
		"Content-Type": "application/json",
		Accept: "application/json",
	};
}

async function call<T>(path: string, payload: Record<string, unknown>): Promise<T> {
	const cfg = config();
	if (!cfg) throw new Error("iyzico is not configured");
	const body = JSON.stringify(payload);
	const response = await fetch(cfg.baseUrl + path, { method: "POST", headers: await authHeaders(cfg, path, body), body });
	const data = (await response.json().catch(() => ({}))) as T & { status?: string; errorMessage?: string };
	if (!response.ok && !data.status) throw new Error(`iyzico HTTP ${response.status}`);
	return data;
}

/** Turkish-style amount iyzico expects: "2400.0", "1250.5". */
const amount = (minor: number) => (minor / 100).toFixed(2).replace(/0$/, "");

export interface CheckoutInput {
	bookingId: string;
	code: string;
	priceMinor: number;
	locale: string;
	callbackUrl: string;
	description: string;
	buyer: { id: string; name: string; email: string; phone: string; ip: string; address: string };
}

/** Start a hosted payment. Returns the page to send the passenger to. */
export async function startCheckout(input: CheckoutInput): Promise<{ ok: true; url: string; token: string } | { ok: false; error: string }> {
	const [first, ...rest] = input.buyer.name.trim().split(/\s+/);
	const surname = rest.join(" ") || first;
	const address = { contactName: input.buyer.name, city: "Istanbul", country: "Turkey", address: input.buyer.address || "Istanbul" };
	const price = amount(input.priceMinor);
	const result = await call<{ status: string; token?: string; paymentPageUrl?: string; errorMessage?: string }>(
		"/payment/iyzipos/checkoutform/initialize/auth/ecom",
		{
			locale: input.locale === "tr" ? "tr" : "en",
			conversationId: input.code,
			price,
			paidPrice: price,
			currency: "TRY",
			basketId: input.bookingId,
			paymentGroup: "PRODUCT",
			callbackUrl: input.callbackUrl,
			enabledInstallments: [1],
			buyer: {
				id: input.buyer.id,
				name: first,
				surname,
				gsmNumber: input.buyer.phone.replace(/[^\d+]/g, ""),
				email: input.buyer.email,
				// iyzico requires a national id; foreign passengers have none, and the
				// placeholder is what iyzico documents for that case.
				identityNumber: "11111111111",
				registrationAddress: address.address,
				ip: input.buyer.ip,
				city: address.city,
				country: address.country,
			},
			shippingAddress: address,
			billingAddress: address,
			basketItems: [{ id: input.code, name: input.description.slice(0, 200), category1: "Transfer", itemType: "VIRTUAL", price }],
		},
	);
	if (result.status !== "success" || !result.paymentPageUrl || !result.token) {
		return { ok: false, error: result.errorMessage ?? "iyzico did not start the payment" };
	}
	return { ok: true, url: result.paymentPageUrl, token: result.token };
}

export interface CheckoutResult {
	paid: boolean;
	bookingId: string | null;
	paidMinor: number;
	currency: string;
	paymentId: string | null;
	error: string | null;
}

/** Ask iyzico what happened to a checkout token. */
export async function checkoutResult(token: string): Promise<CheckoutResult> {
	const data = await call<{
		status: string;
		paymentStatus?: string;
		fraudStatus?: number;
		basketId?: string;
		paidPrice?: number | string;
		currency?: string;
		paymentId?: string;
		errorMessage?: string;
	}>("/payment/iyzipos/checkoutform/auth/ecom/detail", { locale: "tr", token });
	const paid = data.status === "success" && data.paymentStatus === "SUCCESS" && data.fraudStatus !== -1;
	return {
		paid,
		bookingId: data.basketId ?? null,
		paidMinor: Math.round(Number(data.paidPrice ?? 0) * 100),
		currency: data.currency ?? "TRY",
		paymentId: data.paymentId ?? null,
		error: paid ? null : (data.errorMessage ?? data.paymentStatus ?? "payment failed"),
	};
}
