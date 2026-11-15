/**
 * Online client: talks to the developer-operated game server over the
 * manifest-declared `game` WebSocket endpoint (platform JWT auth).
 * Uses sdk.network.reconnectSocket so drops rejoin the room automatically;
 * falls back to a plain sdk.webSocket.connect with manual retries.
 */
import { getSDK } from "@discourse-mini-app/sdk";
import type { MiniAppSDK, MiniAppSocket } from "@discourse-mini-app/sdk";

type ReconnectingSocket = ReturnType<MiniAppSDK["network"]["reconnectSocket"]>;
import type { PlayerAction } from "./engine/game.ts";
import type {
  ClientMessage,
  ClientState,
  RoomOptions,
  ServerMessage,
} from "./engine/protocol.ts";
import type { TableDriver } from "./local.ts";

export function createNetClient(callbacks: {
  onState: (state: ClientState) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}): TableDriver & {
  connect(room: string, name: string, options: RoomOptions): Promise<void>;
  connectionState(): string;
} {
  let sdk: MiniAppSDK | null = null;
  let socket: ReconnectingSocket | MiniAppSocket | null = null;
  let manualTimer: ReturnType<typeof setTimeout> | null = null;
  let manualAttempts = 0;
  let room = "";
  let name = "";
  let options: RoomOptions = { decks: "classic4", eagleMode: "king", bots: true };
  let closed = false;

  const handle = (message: unknown) => {
    const msg = message as ServerMessage;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "hello":
        callbacks.onNotice(`已加入房间 ${msg.room}（${msg.seat} 号位）`);
        break;
      case "state":
        callbacks.onState(msg.state);
        break;
      case "error":
        callbacks.onError(msg.message);
        break;
      case "notice":
        callbacks.onNotice(msg.message);
        break;
      default:
        break;
    }
  };

  const send = (message: ClientMessage) => {
    if (!socket) return;
    socket.send(message as never).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn("[够级] send failed", error);
      callbacks.onError("消息发送失败，正在重连…");
    });
  };

  const connectManual = async (): Promise<void> => {
    if (!sdk || closed) return;
    try {
      const ws = await sdk.webSocket.connect("game", { query: { room } });
      socket = ws;
      manualAttempts = 0;
      await ws.ready;
      await ws.send({ type: "join", room, name, options } as never);
      ws.on("message", (message) => handle(message));
      ws.on("close", () => {
        if (closed) return;
        callbacks.onNotice("连接已断开，正在重连…");
        manualTimer = setTimeout(() => {
          manualAttempts++;
          if (manualAttempts <= 5) void connectManual();
          else callbacks.onError("重连失败，请返回大厅重试。");
        }, 3000);
      });
      ws.on("error", () => {
        // Close handler drives the retry.
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[够级] socket connect failed", error);
      if (closed) return;
      manualTimer = setTimeout(() => {
        manualAttempts++;
        if (manualAttempts <= 5) void connectManual();
        else callbacks.onError("无法连接牌桌服务器。");
      }, 3000);
    }
  };

  const driver: TableDriver & {
    connect(room: string, name: string, options: RoomOptions): Promise<void>;
    connectionState(): string;
  } = {
    onState: callbacks.onState,
    onNotice: callbacks.onNotice,
    onError: callbacks.onError,
    async connect(nextRoom: string, nextName: string, nextOptions: RoomOptions) {
      room = nextRoom;
      name = nextName;
      options = nextOptions;
      closed = false;
      manualAttempts = 0;
      try {
        sdk = getSDK();
      } catch {
        sdk = null;
      }
      if (!sdk) {
        callbacks.onError("未在社区内运行，无法连接在线牌桌。请用人机对战。");
        return;
      }
      try {
        const conn = sdk.network.reconnectSocket("game", {
          query: { room },
          onOpen: async (sock, { reconnected }) => {
            await sock.send({ type: "join", room, name, options } as never);
            callbacks.onNotice(reconnected ? "已恢复连接" : "已连接牌桌服务器");
          },
          onMessage: (message) => handle(message),
        });
        socket = conn;
        await conn.ready;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[够级] reconnectSocket unavailable, falling back", error);
        await connectManual();
      }
    },
    connectionState() {
      if (!socket) return "closed";
      if ("state" in socket) return socket.state;
      return socket.readyState === "open" ? "open" : socket.readyState;
    },
    start() {
      // Online games start from connect(); nothing to do here.
    },
    act(action: PlayerAction) {
      send({ type: "act", action });
    },
    ready() {
      send({ type: "ready" });
    },
    nextRound() {
      send({ type: "next-round" });
    },
    endMatch() {
      send({ type: "end-match" });
    },
    leave() {
      closed = true;
      if (manualTimer) clearTimeout(manualTimer);
      send({ type: "leave" });
      if (socket) {
        socket.close().catch(() => undefined);
        socket = null;
      }
    },
  };
  return driver;
}
