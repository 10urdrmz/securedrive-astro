import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { ChatRoom } from "./chat-room";
import { useChatRooms } from "./server/realtime";

export { PluginBridge, ChatRoom };

/** Rooms are named by an unguessable hash of the booking's secret (src/server/realtime.ts). */
const ROOM = /^[0-9a-f]{64}$/;

export default {
	...handler,
	fetch(request, env, ctx) {
		const chat = (env as { CHAT?: DurableObjectNamespace }).CHAT;
		useChatRooms(chat);
		const url = new URL(request.url);
		if (url.pathname === "/sohbet/ws") {
			const room = url.searchParams.get("room") ?? "";
			if (!ROOM.test(room) || request.headers.get("Upgrade") !== "websocket") return new Response("Not found", { status: 404 });
			if (!chat) return new Response("Not found", { status: 404 });
			return chat.get(chat.idFromName(room)).fetch(request);
		}
		return handler.fetch!(request, env, ctx);
	},
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
