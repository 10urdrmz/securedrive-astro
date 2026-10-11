/**
 * One booking's live chat channel (Cloudflare only). Pages hold a WebSocket open
 * here; when a message is stored the server calls /notify and every open page is
 * told at once, then reloads the thread through its own authenticated endpoint.
 * The socket only ever carries "changed", never message text, so nothing personal
 * passes through it. Hibernation keeps idle rooms free.
 */
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Keep-alive pings are answered without waking the room.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/notify") {
			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.send("changed");
				} catch {
					// Already closing.
				}
			}
			return new Response(null, { status: 204 });
		}
		if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketClose(socket: WebSocket, code: number) {
		try {
			socket.close(code === 1005 ? 1000 : code, "closed");
		} catch {
			// Already closed.
		}
	}
}
