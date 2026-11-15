/**
 * Gouji game server (Bun + WebSocket). Authoritative rooms: the server owns
 * the Game state machine and only ever sends each player their own hand.
 * Bots fill empty seats so a game can start with 1–5 humans.
 *
 * Run:  bun run start        (from server/)
 * Env:  PORT (default 8787), COMMUNITY_ISSUER, APP_ID, SERVER_ORIGIN,
 *       CHANNEL (production|sandbox), DEV_MODE (1 = accept unauthenticated
 *       local connections; default on when no COMMUNITY_ISSUER is set).
 */
import { Game } from "../src/engine/game.ts";
import type { PlayerAction } from "../src/engine/game.ts";
import { botAction } from "../src/engine/ai.ts";
import { roomCode } from "../src/engine/protocol.ts";
import type { ClientMessage, ClientState, RoomOptions, ServerMessage } from "../src/engine/protocol.ts";
import { authenticateUpgrade, loadConfig } from "./auth.ts";
import type { Identity } from "./auth.ts";

const config = loadConfig(process.env as Record<string, string | undefined>);
const PORT = Number(process.env.PORT ?? 8787);
const BOT_STEP_MS = 650;

interface Conn {
  ws: WebSocket;
  userId: string;
  name: string;
  seat: number | null;
  room: string | null;
  lastMsgAt: number;
  msgCount: number;
}

class Room {
  readonly code: string;
  readonly options: RoomOptions;
  game: Game;
  clients = new Map<string, Conn>();
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = Date.now();

  constructor(code: string, options: RoomOptions) {
    this.code = code;
    this.options = options;
    this.game = new Game(code, options);
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  idleMs(): number {
    return Date.now() - this.lastActivity;
  }

  seatOf(userId: string): number | null {
    for (const p of this.game.players) {
      if (p.userId === userId && p.name !== "") return p.seat;
    }
    return null;
  }

  join(conn: Conn, name: string, requestedSeat?: number): { seat: number } | { error: string } {
    const existing = this.seatOf(conn.userId);
    if (existing !== null) {
      this.game.player(existing).connected = true;
      conn.seat = existing;
      conn.room = this.code;
      this.clients.set(conn.userId, conn);
      return { seat: existing };
    }
    if (this.game.phase !== "lobby") return { error: "对局已经开始，无法加入" };
    const free = this.game.players.filter((p) => p.name === "").map((p) => p.seat);
    if (free.length === 0) return { error: "房间已满" };
    const seat = requestedSeat !== undefined && free.includes(requestedSeat) ? requestedSeat : free[0];
    const ok = this.game.addPlayer(seat, name, false, conn.userId);
    if (!ok) return { error: "选座失败" };
    conn.seat = seat;
    conn.room = this.code;
    this.clients.set(conn.userId, conn);
    this.touch();
    this.broadcast();
    return { seat };
  }

  leave(userId: string): void {
    const conn = this.clients.get(userId);
    if (!conn) return;
    this.clients.delete(userId);
    const seat = this.seatOf(userId);
    if (seat !== null) this.game.player(seat).connected = false;
    this.touch();
    if (this.game.phase === "lobby" && seat !== null) {
      this.game.removePlayer(seat);
    }
    this.broadcast();
  }

  ready(seat: number): void {
    if (this.game.phase !== "lobby") return;
    this.game.setReady(seat);
    // Start when every human is ready: bots fill the rest.
    const humans = this.game.players.filter((p) => p.name !== "" && !p.isBot);
    if (humans.length > 0 && humans.every((p) => p.ready)) {
      this.game.fillBots();
      for (const p of this.game.players) {
        if (p.name !== "" && !p.ready) this.game.setReady(p.seat);
      }
    }
    this.touch();
    this.broadcast();
    this.scheduleBots();
  }

  act(userId: string, action: PlayerAction): { ok: boolean; error?: string } {
    const seat = this.seatOf(userId);
    if (seat === null) return { ok: false, error: "你还没有加入房间" };
    const result = this.game.act(seat, action);
    if (result.ok) {
      this.touch();
      this.broadcast();
      this.scheduleBots();
    }
    return result;
  }

  nextRound(userId: string): { ok: boolean; error?: string } {
    const seat = this.seatOf(userId);
    if (seat === null) return { ok: false, error: "你还没有加入房间" };
    const result = this.game.act(seat, { kind: "next-round" });
    if (result.ok) {
      this.touch();
      this.broadcast();
      this.scheduleBots();
    }
    return result;
  }

  endMatch(): void {
    const options = this.options;
    const keep = this.game.players.map((p) => ({ seat: p.seat, name: p.name, isBot: p.isBot, userId: p.userId }));
    this.game = new Game(this.code, options);
    for (const p of keep) {
      if (p.name !== "") this.game.addPlayer(p.seat, p.name, p.isBot, p.userId);
    }
    this.broadcast();
  }

  stateFor(seat: number | null, userId: string | null): ClientState {
    const base = seat !== null ? this.game.snapshotFor(seat) : this.game.publicState();
    return {
      ...base,
      hand: seat !== null ? this.game.player(seat).hand.map((c) => ({ ...c })) : [],
      legal: seat !== null ? this.game.legalActions(seat) : {
        canPlay: false, canPass: false, canBurn: false, canLet: false, canRevolution: false, hintCardIds: null,
      },
      youSeat: seat,
      youUserId: userId,
    };
  }

  broadcast(): void {
    for (const [userId, conn] of this.clients) {
      const seat = this.seatOf(userId);
      this.send(conn, { type: "state", state: this.stateFor(seat, userId) });
    }
  }

  send(conn: Conn, message: ServerMessage): void {
    try {
      conn.ws.send(JSON.stringify(message));
    } catch {
      // The socket is gone; leave() will clean it up.
    }
  }

  scheduleBots(): void {
    if (this.botTimer) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (this.stepBots()) {
        this.broadcast();
        this.scheduleBots();
      }
    }, BOT_STEP_MS);
  }

  /** Drive one bot action. Returns true when more bot work may remain. */
  stepBots(): boolean {
    const game = this.game;
    // Revolution has a 15 s deadline; advance it even when a human is silent.
    if (game.tick(Date.now())) return true;
    if (game.phase === "revolution") {
      let acted = false;
      for (const seat of game.revolutionEligible) {
        if (!game.player(seat).isBot) continue;
        const action = botAction(game, seat);
        if (action) {
          const r = game.act(seat, action);
          if (r.ok) acted = true;
        }
      }
      return acted || game.phase === "revolution";
    }
    if (game.phase !== "playing") return false;
    if (game.resolveStuckTurn()) return true;
    // Burn interrupts first.
    for (let seat = 1; seat <= 6; seat++) {
      if (!game.player(seat).isBot) continue;
      if (game.legalActions(seat).canBurn) {
        const action = botAction(game, seat);
        if (action && action.kind === "burn") {
          const r = game.act(seat, action);
          if (r.ok) return true;
        }
      }
    }
    const turn = game.turnSeat;
    if (turn === null) return false;
    if (!game.player(turn).isBot) return false;
    const action = botAction(game, turn);
    if (!action) return false;
    const result = game.act(turn, action);
    if (!result.ok) {
      // A bot must never send an illegal action; log and stop the chain.
      console.warn(`[room ${this.code}] bot ${turn} ${action.kind} rejected: ${result.error}`);
      return false;
    }
    return true;
  }
}

const rooms = new Map<string, Room>();

function getOrCreateRoom(code: string, options?: RoomOptions): Room {
  const existing = rooms.get(code);
  if (existing) return existing;
  const room = new Room(code, options ?? { decks: "classic4", eagleMode: "king", bots: true });
  rooms.set(code, room);
  return room;
}

function handleMessage(conn: Conn, data: unknown): void {
  const now = Date.now();
  if (now - conn.lastMsgAt > 1000) {
    conn.lastMsgAt = now;
    conn.msgCount = 0;
  }
  conn.msgCount++;
  if (conn.msgCount > 30) return; // simple per-second rate limit
  const room = conn.room ? rooms.get(conn.room) : undefined;
  const send = (message: ServerMessage): void => {
    if (room) room.send(conn, message);
    else {
      try { conn.ws.send(JSON.stringify(message)); } catch { /* ignore */ }
    }
  };
  let msg: ClientMessage;
  try {
    msg = JSON.parse(String(data)) as ClientMessage;
  } catch {
    send({ type: "error", message: "消息不是合法 JSON" });
    return;
  }
  switch (msg.type) {
    case "join": {
      const code = (msg.room ?? "").toUpperCase().slice(0, 8) || roomCode();
      const target = getOrCreateRoom(code, msg.options);
      const result = target.join(conn, msg.name ?? "牌友", undefined);
      if ("error" in result) {
        send({ type: "error", message: result.error });
        return;
      }
      send({
        type: "hello",
        room: code,
        seat: result.seat,
        userId: conn.userId,
        mode: config.devMode ? "dev" : "secure",
      });
      target.broadcast();
      break;
    }
    case "ready": {
      if (!room) return send({ type: "error", message: "请先加入房间" });
      const seat = room.seatOf(conn.userId);
      if (seat === null) return send({ type: "error", message: "请先加入房间" });
      room.ready(seat);
      break;
    }
    case "act": {
      if (!room) return send({ type: "error", message: "请先加入房间" });
      const result = room.act(conn.userId, msg.action);
      if (!result.ok) {
        send({ type: "error", message: result.error ?? "操作被拒绝" });
        // A fresh state lets the client retry from a correct view.
        send({ type: "state", state: room.stateFor(room.seatOf(conn.userId), conn.userId) });
      }
      break;
    }
    case "next-round": {
      if (!room) return send({ type: "error", message: "请先加入房间" });
      const result = room.nextRound(conn.userId);
      if (!result.ok) {
        send({ type: "error", message: result.error ?? "操作被拒绝" });
        send({ type: "state", state: room.stateFor(room.seatOf(conn.userId), conn.userId) });
      }
      break;
    }
    case "end-match": {
      if (!room) return;
      room.endMatch();
      break;
    }
    case "leave": {
      if (room) room.leave(conn.userId);
      conn.room = null;
      conn.seat = null;
      break;
    }
    default:
      send({ type: "error", message: "未知消息类型" });
  }
}

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && room.idleMs() > 10 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

const server = Bun.serve<Conn>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, mode: config.devMode ? "dev" : "secure", rooms: rooms.size });
    }
    if (url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "gouji-game-server",
        mode: config.devMode ? "dev" : "secure",
        rooms: rooms.size,
        ws: "/gouji?room=CODE",
      });
    }
    if (url.pathname === "/gouji") {
      return (async () => {
        let identity: Identity;
        try {
          identity = await authenticateUpgrade(req, config);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "unauthorized";
          return new Response(`unauthorized: ${reason}`, { status: 401 });
        }
        const conn: Conn = {
          ws: null as unknown as WebSocket,
          userId: `${identity.iss}:${identity.sub}`,
          name: "牌友",
          seat: null,
          room: null,
          lastMsgAt: 0,
          msgCount: 0,
        };
        const upgraded = server.upgrade(req, { data: conn });
        if (!upgraded) return new Response("upgrade failed", { status: 500 });
        return undefined;
      })();
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const conn = ws.data as unknown as Conn;
      conn.ws = ws as unknown as WebSocket;
      ws.send(JSON.stringify({
        type: "notice",
        message: config.devMode
          ? "开发模式：未验证平台 JWT，仅供本地调试"
          : "已连接牌桌服务器",
      } satisfies ServerMessage));
    },
    message(ws, data) {
      const conn = ws.data as unknown as Conn;
      handleMessage(conn, data);
    },
    close(ws) {
      const conn = ws.data as unknown as Conn;
      if (conn.room) {
        const room = rooms.get(conn.room);
        if (room) room.leave(conn.userId);
      }
    },
  },
});

if (config.devMode) {
  console.warn("[gouji-server] DEV MODE: platform JWT is NOT verified. Local use only — do not expose this server publicly.");
} else {
  console.log(`[gouji-server] secure mode: issuer=${config.issuer} app=${config.appId}`);
}
console.log(`[gouji-server] listening on http://localhost:${PORT} (ws /gouji?room=CODE)`);
export { server };
