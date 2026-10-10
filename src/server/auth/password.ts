/**
 * Password hashing with PBKDF2-SHA256 from WebCrypto (available on Workers and Node).
 * Stored as `pbkdf2$<iterations>$<salt>$<hash>` so the cost can be raised later.
 *
 * Workers cap PBKDF2 at 100 000 iterations, so that is the ceiling here.
 */
import { fromBase64Url, toBase64Url } from "../ids";

const ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 10;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations }, key, 256);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt, ITERATIONS);
	return `pbkdf2$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
	if (!stored) return false;
	const [scheme, iter, saltText, hashText] = stored.split("$");
	const iterations = Number(iter);
	if (scheme !== "pbkdf2" || !Number.isInteger(iterations) || !saltText || !hashText) return false;
	const actual = await derive(password, fromBase64Url(saltText), iterations);
	const expected = fromBase64Url(hashText);
	if (actual.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
	return diff === 0;
}
