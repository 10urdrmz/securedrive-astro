/**
 * Live chat push. On Cloudflare each booking has a ChatRoom (src/chat-room.ts) that
 * tells open pages the moment a message is stored; locally there is none and pages
 * simply keep polling.
 */
import type { Booking } from "./bookings";

/** The room's name: a hash of the booking's secret, so it cannot be guessed from the code. */
export async function chatRoom(booking: Pick<Booking, "id" | "tracking_token">): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`chat:${booking.id}:${booking.tracking_token}`));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Set by src/worker.ts on every request; stays null on Node, where pages just poll.
let rooms: DurableObjectNamespace | null = null;
export function useChatRooms(namespace: DurableObjectNamespace | undefined): void {
	rooms = namespace ?? null;
}

/** Wake every page that has this booking's chat open. Never fails the caller. */
export async function notifyChat(booking: Pick<Booking, "id" | "tracking_token">): Promise<void> {
	if (!rooms) return;
	try {
		const room = await chatRoom(booking);
		await rooms.get(rooms.idFromName(room)).fetch("https://chat/notify", { method: "POST" });
	} catch {
		// The room is unreachable: pages fall back to polling.
	}
}
