/** Shared Gouji types. Pure data, no DOM, no SDK. */

export type RankId =
  | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A" | "2"
  | "small-joker" | "big-joker" | "eagle";

export type RankName = "头科" | "二科" | "三科" | "四科" | "二落" | "大落";

export const RANK_ORDER: RankId[] = [
  "3", "4", "5", "6", "7", "8", "9", "10",
  "J", "Q", "K", "A", "2", "small-joker", "big-joker", "eagle",
];

export const RANK_LABEL: Record<RankId, string> = {
  "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
  "10": "10", J: "J", Q: "Q", K: "K", A: "A",
  "2": "2", "small-joker": "小王", "big-joker": "大王", eagle: "鹰",
};

export const RANK_POINTS: Record<RankName, number> = {
  头科: 4, 二科: 2, 三科: 0, 四科: 0, 二落: -2, 大落: -4,
};

export const RANK_NAMES: RankName[] = [
  "头科", "二科", "三科", "四科", "二落", "大落",
];

export interface FederationScore {
  valid: boolean;
  raw: number;
  doubled: boolean;
  total: number;
}

/** Score for one federation from its three members' finishing ranks. */
export function federationScore(ranks: RankName[]): FederationScore {
  const valid = ranks.length === 3 && new Set(ranks).size === 3;
  if (!valid) return { valid: false, raw: 0, doubled: false, total: 0 };
  const raw = ranks.reduce((sum, rank) => sum + RANK_POINTS[rank], 0);
  const doubled =
    ranks.includes("头科") && ranks.includes("二科") && ranks.includes("三科");
  const total = Math.max(0, doubled ? raw * 2 : raw);
  return { valid: true, raw, doubled, total };
}

export function seatRelation(seat: number): {
  seat: number; opposite: number; teammates: [number, number];
} | null {
  if (!Number.isInteger(seat) || seat < 1 || seat > 6) return null;
  return {
    seat,
    opposite: ((seat + 2) % 6) + 1,
    teammates: [((seat + 1) % 6) + 1, ((seat + 3) % 6) + 1],
  };
}

/** Federation of a seat: seats 1/3/5 are federation A, 2/4/6 federation B. */
export function federationOf(seat: number): "A" | "B" {
  return seat % 2 === 1 ? "A" : "B";
}

export interface Card {
  id: string;
  rank: RankId;
  suit: string;
  deck: number;
}

export type DeckOption = "classic4" | "sixEagle";
export type EagleMode = "king" | "joker" | "removed";

export interface GameOptions {
  decks: DeckOption;
  eagleMode: EagleMode;
}

export const DEFAULT_OPTIONS: GameOptions = {
  decks: "classic4",
  eagleMode: "king",
};

export function deckCount(options: GameOptions): number {
  return options.decks === "sixEagle" ? 6 : 4;
}

export function isWildRank(rank: RankId): boolean {
  return rank === "2" || rank === "small-joker" || rank === "big-joker" || rank === "eagle";
}

/** A joker/eagle that raises a play's effective rank (2 does not). */
export function isRaisingWild(rank: RankId): boolean {
  return rank === "small-joker" || rank === "big-joker" || rank === "eagle";
}
