/**
 * Vehicle photos that carriers and ops upload (sd_vehicle_classes.photo,
 * sd_fleet_vehicles.photo). On Cloudflare they go to the MEDIA R2 bucket under
 * "fleet/"; in local development to ./uploads/fleet. Served by /api/arac-foto/<key>.
 */
import { ulid } from "./ids";

const PREFIX = "fleet/";
const MAX_BYTES = 6 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const KEY = /^fleet\/[0-9A-Z]{26}\.(jpg|png|webp)$/;

interface Bucket {
	put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
	get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
	delete(key: string): Promise<void>;
}

async function bucket(): Promise<Bucket | null> {
	try {
		const specifier = "cloudflare:workers";
		const { env } = (await import(/* @vite-ignore */ specifier)) as { env?: { MEDIA?: Bucket } };
		return env?.MEDIA ?? null;
	} catch {
		return null;
	}
}

// Node modules load by a computed name so the Workers bundle never tries to include them.
const nodeFs = () => import(/* @vite-ignore */ ["node:fs", "promises"].join("/")) as Promise<typeof import("node:fs/promises")>;
const nodePath = () => import(/* @vite-ignore */ ["node", "path"].join(":")) as Promise<typeof import("node:path")>;

async function localPath(key: string) {
	return (await nodePath()).join(process.cwd(), "uploads", key);
}

export const photoUrl = (key: string | null | undefined) => (key && KEY.test(key) ? `/api/arac-foto/${key.slice(PREFIX.length)}` : null);

/**
 * Store an uploaded photo and return its key, or null when no file was sent.
 * Throws a message for the form when the file is too big or not an image.
 */
export async function savePhoto(file: FormDataEntryValue | null): Promise<string | null> {
	if (!file || typeof file === "string" || file.size === 0) return null;
	const ext = TYPES[file.type];
	if (!ext) throw new Error("Fotoğraf JPG, PNG ya da WebP olmalı.");
	if (file.size > MAX_BYTES) throw new Error("Fotoğraf en çok 6 MB olabilir.");
	const key = `${PREFIX}${ulid()}.${ext}`;
	const data = await file.arrayBuffer();
	const r2 = await bucket();
	if (r2) {
		await r2.put(key, data, { httpMetadata: { contentType: file.type } });
	} else {
		const { mkdir, writeFile } = await nodeFs();
		const { dirname } = await nodePath();
		const path = await localPath(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, new Uint8Array(data));
	}
	return key;
}

export async function deletePhoto(key: string | null | undefined) {
	if (!key || !KEY.test(key)) return;
	const r2 = await bucket();
	try {
		if (r2) await r2.delete(key);
		else await (await nodeFs()).unlink(await localPath(key));
	} catch {
		// Already gone.
	}
}

export async function readPhoto(name: string): Promise<{ body: ReadableStream | Uint8Array; type: string } | null> {
	const key = `${PREFIX}${name}`;
	if (!KEY.test(key)) return null;
	const type = Object.entries(TYPES).find(([, ext]) => key.endsWith(`.${ext}`))![0];
	const r2 = await bucket();
	if (r2) {
		const object = await r2.get(key);
		return object ? { body: object.body, type: object.httpMetadata?.contentType ?? type } : null;
	}
	try {
		return { body: new Uint8Array(await (await nodeFs()).readFile(await localPath(key))), type };
	} catch {
		return null;
	}
}
