/**
 * A vehicle photo uploaded by ops or a carrier (server/photos.ts). Keys are random and
 * never reused, so browsers may keep them for a long time.
 */
import type { APIRoute } from "astro";
import { readPhoto } from "../../../server/photos";

export const GET: APIRoute = async ({ params }) => {
	const photo = await readPhoto(params.name ?? "");
	if (!photo) return new Response("Not found", { status: 404 });
	return new Response(photo.body as BodyInit, {
		headers: { "Content-Type": photo.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
	});
};
