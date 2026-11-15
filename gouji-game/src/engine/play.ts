/** Deck building and play parsing / comparison. Pure functions. */
import {
  RANK_ORDER, deckCount, isRaisingWild, isWildRank,
} from "./types.ts";
import type { Card, GameOptions, RankId } from "./types.ts";

export const SUITS = ["♠", "♥", "♦", "♣"] as const;

const PLAIN_RANKS: RankId[] = [
  "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
];

/** Minimum same-rank count for a Gouji card. 口诀：单钱单花、双A双K、三Q、四J、五10。 */
export const GOUJI_THRESHOLD: Partial<Record<RankId, number>> = {
  "10": 5, J: 4, Q: 3, K: 2, A: 2, "2": 1,
  "small-joker": 1, "big-joker": 1, eagle: 1,
};

export function rankIndex(rank: RankId): number {
  return RANK_ORDER.indexOf(rank);
}

export function buildDeck(options: GameOptions): Card[] {
  const decks = deckCount(options);
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) {
    for (const rank of PLAIN_RANKS) {
      for (const suit of SUITS) {
        cards.push({ id: `d${d}-${rank}${suit}`, rank, suit, deck: d });
      }
    }
    cards.push({ id: `d${d}-2a`, rank: "2", suit: "♠", deck: d });
    cards.push({ id: `d${d}-2b`, rank: "2", suit: "♥", deck: d });
    cards.push({ id: `d${d}-2c`, rank: "2", suit: "♦", deck: d });
    cards.push({ id: `d${d}-2d`, rank: "2", suit: "♣", deck: d });
    cards.push({ id: `d${d}-sj`, rank: "small-joker", suit: "", deck: d });
    cards.push({ id: `d${d}-bj`, rank: "big-joker", suit: "", deck: d });
    if (options.decks === "sixEagle" && options.eagleMode !== "removed") {
      cards.push({ id: `d${d}-eagle`, rank: "eagle", suit: "", deck: d });
    }
  }
  return cards;
}

export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export interface PlayInfo {
  cards: Card[];
  /** Rank of the non-wild cards, or the highest wild rank for all-wild plays. */
  baseRank: RankId;
  /** Number of non-wild cards. */
  baseCount: number;
  total: number;
  wildCount: number;
  twoCount: number;
  smallCount: number;
  bigCount: number;
  eagleCount: number;
  effectiveRank: RankId;
  isGouji: boolean;
  isPureGouji: boolean;
}

/**
 * Parse a set of cards as one play. Returns null for an invalid shape:
 * mixed base ranks, or wilds attached to 3/4.
 * A play is N copies of one base rank, optionally with 2s/jokers/eagles
 * attached as wilds. All-wild plays use their highest wild rank as base.
 */
export function parsePlay(cards: Card[]): PlayInfo | null {
  if (cards.length === 0) return null;
  let twoCount = 0;
  let smallCount = 0;
  let bigCount = 0;
  let eagleCount = 0;
  const base: Card[] = [];
  for (const card of cards) {
    if (card.rank === "2") twoCount++;
    else if (card.rank === "small-joker") smallCount++;
    else if (card.rank === "big-joker") bigCount++;
    else if (card.rank === "eagle") eagleCount++;
    else base.push(card);
  }
  const wildCount = twoCount + smallCount + bigCount + eagleCount;
  let baseRank: RankId;
  if (base.length > 0) {
    baseRank = base[0].rank;
    if (!base.every((c) => c.rank === baseRank)) return null;
    // 3 and 4 may never carry wilds.
    if ((baseRank === "3" || baseRank === "4") && wildCount > 0) return null;
  } else {
    // All wild: base rank is the highest wild rank present.
    if (eagleCount > 0) baseRank = "eagle";
    else if (bigCount > 0) baseRank = "big-joker";
    else if (smallCount > 0) baseRank = "small-joker";
    else baseRank = "2";
  }
  const effectiveRank: RankId =
    eagleCount > 0 ? "eagle"
    : bigCount > 0 ? "big-joker"
    : smallCount > 0 ? "small-joker"
    : baseRank;
  const hasRaisingWild = smallCount + bigCount + eagleCount > 0;
  const threshold = GOUJI_THRESHOLD[baseRank] ?? null;
  const isGouji =
    hasRaisingWild ||
    threshold !== null && cards.length >= threshold;
  const isPureGouji =
    wildCount === 0 &&
    (baseRank === "10" || baseRank === "J" || baseRank === "Q" ||
      baseRank === "K" || baseRank === "A") &&
    threshold !== null && cards.length >= threshold;
  return {
    cards: [...cards],
    baseRank,
    baseCount: base.length,
    total: cards.length,
    wildCount,
    twoCount,
    smallCount,
    bigCount,
    eagleCount,
    effectiveRank,
    isGouji,
    isPureGouji,
  };
}

/**
 * Can play `a` beat play `b`? Base counts must match (wilds are attachments,
 * so totals may differ). Compare effective rank, then raising-wild count,
 * then base rank. All-wild plays compare by rank, then by count
 * (two big jokers beat one big joker — 大王二杀一).
 */
export function beats(a: PlayInfo, b: PlayInfo): boolean {
  if (a.baseCount === 0 && b.baseCount === 0) {
    const ra = rankIndex(a.effectiveRank);
    const rb = rankIndex(b.effectiveRank);
    if (ra !== rb) return ra > rb;
    return a.total > b.total;
  }
  if (a.baseCount !== b.baseCount) return false;
  const ra = rankIndex(a.effectiveRank);
  const rb = rankIndex(b.effectiveRank);
  if (ra !== rb) return ra > rb;
  const wa = a.smallCount + a.bigCount + a.eagleCount;
  const wb = b.smallCount + b.bigCount + b.eagleCount;
  if (wa !== wb) return wa > wb;
  return rankIndex(a.baseRank) > rankIndex(b.baseRank);
}

/** Does this hand contain a pure Gouji card (for 自然点)? */
export function hasPureGoujiCard(hand: Card[]): boolean {
  const counts = new Map<RankId, number>();
  for (const card of hand) {
    if (!isWildRank(card.rank)) {
      counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
    }
  }
  for (const [rank, count] of counts) {
    const threshold = GOUJI_THRESHOLD[rank];
    if (threshold !== undefined && count >= threshold) return true;
  }
  return false;
}

/** Number of same-suit 3s, by suit — used to pick the first leader (亮3上班). */
export function bestThreeSuit(hand: Card[]): { suit: string; count: number } {
  const counts = new Map<string, number>();
  for (const card of hand) {
    if (card.rank === "3") counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1);
  }
  let best = { suit: "", count: 0 };
  for (const [suit, count] of counts) {
    if (count > best.count) best = { suit, count };
  }
  return best;
}

export function groupHand(hand: Card[]): Map<RankId, Card[]> {
  const groups = new Map<RankId, Card[]>();
  for (const card of hand) {
    const list = groups.get(card.rank) ?? [];
    list.push(card);
    groups.set(card.rank, list);
  }
  return groups;
}

/**
 * Enumerate candidate plays from a hand, cheapest first. Caps the result so
 * the AI stays fast on 54-card hands. `current` limits to plays that beat it.
 */
export function enumeratePlays(hand: Card[], current: PlayInfo | null): PlayInfo[] {
  const groups = groupHand(hand);
  const wilds = [
    ...(groups.get("2") ?? []),
    ...(groups.get("small-joker") ?? []),
    ...(groups.get("big-joker") ?? []),
    ...(groups.get("eagle") ?? []),
  ];
  const out: PlayInfo[] = [];
  const seen = new Set<string>();
  const push = (cards: Card[]) => {
    const play = parsePlay(cards);
    if (!play) return;
    if (current && !beats(play, current)) return;
    const key = [...cards.map((c) => c.id)].sort().join(",");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(play);
  };
  // Base-rank plays, with and without one wild attached.
  for (const [rank, cards] of groups) {
    if (isWildRank(rank)) continue;
    for (let n = 1; n <= cards.length; n++) {
      const base = cards.slice(0, n);
      push(base);
      if (rank === "3" || rank === "4") continue;
      for (const wild of wilds) {
        push([...base, wild]);
      }
    }
  }
  // All-wild plays: singles and pairs of each wild rank.
  for (const rank of ["2", "small-joker", "big-joker", "eagle"] as RankId[]) {
    const cards = groups.get(rank) ?? [];
    for (let n = 1; n <= Math.min(2, cards.length); n++) {
      push(cards.slice(0, n));
    }
  }
  out.sort((a, b) =>
    rankIndex(a.effectiveRank) - rankIndex(b.effectiveRank) ||
    a.total - b.total ||
    a.wildCount - b.wildCount
  );
  return out.slice(0, 240);
}
