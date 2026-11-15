/** Wire protocol between the mini-app client and the game server. */
import type { GameOptions } from "./types.ts";
import type { PlayerAction, PublicState } from "./game.ts";
import type { Card } from "./types.ts";

export type ClientMessage =
  | { type: "join"; room: string; name?: string; options?: RoomOptions }
  | { type: "ready"; seat?: number }
  | { type: "act"; action: PlayerAction }
  | { type: "next-round" }
  | { type: "end-match" }
  | { type: "leave" };

export interface ClientState extends PublicState {
  hand: Card[];
  legal: {
    canPlay: boolean;
    canPass: boolean;
    canBurn: boolean;
    canLet: boolean;
    canRevolution: boolean;
    hintCardIds: string[] | null;
  };
  youSeat: number | null;
  youUserId: string | null;
}

export type ServerMessage =
  | { type: "hello"; room: string; seat: number; userId: string; mode: "dev" | "secure" }
  | { type: "state"; state: ClientState }
  | { type: "error"; message: string }
  | { type: "notice"; message: string };

export interface RoomOptions extends GameOptions {
  /** Fill empty seats with bots when the game starts. */
  bots: boolean;
}

export function roomCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}
