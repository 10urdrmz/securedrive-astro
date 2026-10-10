const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit millisecond time + 80 random bits, sortable and unguessable. */
export function ulid(time = Date.now()): string {
	let out = "";
	let t = time;
	for (let i = 0; i < 10; i++) {
		out = CROCKFORD[t % 32] + out;
		t = Math.floor(t / 32);
	}
	const random = crypto.getRandomValues(new Uint8Array(16));
	for (const byte of random) out += CROCKFORD[byte % 32];
	return out;
}

export function randomToken(bytes = 32): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
