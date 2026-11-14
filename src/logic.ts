/** Pure Gouji rules used by the guide's interactive tools. No DOM, no SDK. */

export type RankId =
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "A"
  | "2"
  | "small-joker"
  | "big-joker";

export type RankName = "头科" | "二科" | "三科" | "四科" | "二落" | "大落";

/** Card order, smallest first. Suits do not matter in Gouji. */
export const RANK_ORDER: RankId[] = [
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
  "2",
  "small-joker",
  "big-joker",
];

export const RANK_LABEL: Record<RankId, string> = {
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  "10": "10",
  J: "J",
  Q: "Q",
  K: "K",
  A: "A",
  "2": "2（钱）",
  "small-joker": "小王（小花）",
  "big-joker": "大王（大花）",
};

/**
 * Minimum count for a same-rank hand to be a Gouji card.
 * 口诀：单钱单花、双 A 双 K、三 Q、四 J、五 10。
 * Ranks 3–9 have no threshold: however many you hold, they are not
 * Gouji cards unless a joker is attached.
 */
export const GOUJI_THRESHOLD: Partial<Record<RankId, number>> = {
  "10": 5,
  J: 4,
  Q: 3,
  K: 2,
  A: 2,
  "2": 1,
  "small-joker": 1,
  "big-joker": 1,
};

export interface GoujiCheck {
  isGouji: boolean;
  threshold: number | null;
  /** How many more cards of this rank are needed; 0 when it qualifies. */
  missing: number;
  withWang: boolean;
}

export function checkGouji(
  rank: RankId,
  count: number,
  withWang: boolean
): GoujiCheck {
  const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
  if (withWang) {
    return { isGouji: true, threshold: null, missing: 0, withWang: true };
  }
  const threshold = GOUJI_THRESHOLD[rank] ?? null;
  if (threshold === null) {
    return { isGouji: false, threshold: null, missing: 0, withWang: false };
  }
  return {
    isGouji: safeCount >= threshold,
    threshold,
    missing: Math.max(0, threshold - safeCount),
    withWang: false,
  };
}

/** Points for one finishing rank. Federation totals count only positive scores. */
export const RANK_POINTS: Record<RankName, number> = {
  头科: 4,
  二科: 2,
  三科: 0,
  四科: 0,
  二落: -2,
  大落: -4,
};

export const RANK_NAMES: RankName[] = [
  "头科",
  "二科",
  "三科",
  "四科",
  "二落",
  "大落",
];

export interface FederationScore {
  valid: boolean;
  raw: number;
  doubled: boolean;
  total: number;
}

/**
 * Score for one federation from its three members' finishing ranks.
 * The three ranks must be distinct (three different players).
 * 串三户：头科 + 二科 + 三科 together doubles the total (6 × 2 = 12).
 * A negative federation total is recorded as 0.
 */
export function federationScore(ranks: RankName[]): FederationScore {
  const valid =
    ranks.length === 3 && new Set(ranks).size === 3;
  if (!valid) {
    return { valid: false, raw: 0, doubled: false, total: 0 };
  }
  const raw = ranks.reduce((sum, rank) => sum + RANK_POINTS[rank], 0);
  const doubled =
    ranks.includes("头科") && ranks.includes("二科") && ranks.includes("三科");
  const total = Math.max(0, doubled ? raw * 2 : raw);
  return { valid: true, raw, doubled, total };
}

/** Seat relations at a six-player table. Seats are numbered 1–6 clockwise. */
export interface SeatRelation {
  seat: number;
  opposite: number;
  teammates: [number, number];
}

export function seatRelation(seat: number): SeatRelation | null {
  if (!Number.isInteger(seat) || seat < 1 || seat > 6) {
    return null;
  }
  const opposite = ((seat + 2) % 6) + 1;
  const teammates: [number, number] = [
    ((seat + 1) % 6) + 1,
    ((seat + 3) % 6) + 1,
  ];
  return { seat, opposite, teammates };
}

/** Sections of the guide, in reading order. Used to remember where the reader stopped. */
export const SECTIONS = [
  "overview",
  "ranking",
  "gouji-cards",
  "flow",
  "core-rules",
  "scoring",
  "tribute",
  "six-decks",
  "terms",
  "tips",
  "faq",
] as const;

export type SectionId = (typeof SECTIONS)[number];

export function isSectionId(value: unknown): value is SectionId {
  return (
    typeof value === "string" && (SECTIONS as readonly string[]).includes(value)
  );
}
