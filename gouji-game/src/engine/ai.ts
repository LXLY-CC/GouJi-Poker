/** Heuristic bots. Always legal, never trusts client state. */
import { enumeratePlays, parsePlay, rankIndex } from "./play.ts";
import { isWildRank } from "./types.ts";
import type { Game, PlayerAction } from "./game.ts";
import type { PlayInfo } from "./play.ts";
import type { Card, RankId } from "./types.ts";

function isGoujiRankPlay(play: PlayInfo): boolean {
  return play.isGouji;
}


/** Plays a bot may actually use: 3s only as the final play, and while the
 * burn chain is live every non-final play must carry a joker. */
function usablePlays(game: Game, seat: number, current: PlayInfo | null): PlayInfo[] {
  const hand = game.player(seat).hand;
  const p = game.player(seat);
  let plays = enumeratePlays(hand, current);
  plays = plays.filter(
    (pl) => !pl.cards.some((c) => c.rank === "3") || pl.total === hand.length
  );
  if (p.burnActive) {
    plays = plays.filter(
      (pl) => pl.total === hand.length || pl.smallCount + pl.bigCount + pl.eagleCount > 0
    );
  }
  return plays;
}

/** Pick the smallest legal lead. Prefers shedding low singles, keeps Gouji cards whole. */
function chooseLead(game: Game, seat: number): PlayerAction | null {
  const hand = game.player(seat).hand;
  const p = game.player(seat);
  const plays = usablePlays(game, seat, null);
  if (plays.length === 0) return null;
  // Opening: lead a 4 if pending open.
  if (p.pendingOpen) {
    const fours = plays.filter((pl) => pl.cards.some((c) => c.rank === "4"));
    if (fours.length > 0) return { kind: "play", cardIds: fours[0].cards.map((c) => c.id) };
  }
  // Open the point early with the smallest pure Gouji card.
  if (!p.opened) {
    const pure = plays.filter((pl) => pl.isPureGouji);
    if (pure.length > 0) {
      return { kind: "play", cardIds: pure[0].cards.map((c) => c.id) };
    }
  }
  // Prefer a low single; avoid breaking a Gouji combo or spending a joker.
  const singles = plays.filter((pl) => pl.total === 1 && !isWildRank(pl.baseRank));
  if (singles.length > 0) {
    return { kind: "play", cardIds: singles[0].cards.map((c) => c.id) };
  }
  const cheap = plays.filter((pl) => pl.wildCount === 0 && !pl.isGouji);
  if (cheap.length > 0) {
    return { kind: "play", cardIds: cheap[0].cards.map((c) => c.id) };
  }
  return { kind: "play", cardIds: plays[0].cards.map((c) => c.id) };
}

function chooseFollow(game: Game, seat: number): PlayerAction | null {
  const hand = game.player(seat).hand;
  const p = game.player(seat);
  const current = game.currentPlay;
  if (!current) return chooseLead(game, seat);
  const beats = usablePlays(game, seat, current.play);
  if (beats.length === 0) return { kind: "pass" };
  const goujiMode = current.play.isGouji && game.finishedCount() < 2;
  // Opponent's Gouji card: the opposite must answer; beat with the cheapest Gouji.
  if (goujiMode && game.goujiOpposite === seat) {
    const goujiBeats = beats.filter((pl) => pl.isGouji);
    const pick = goujiBeats[0] ?? beats[0];
    return { kind: "play", cardIds: pick.cards.map((c) => c.id) };
  }
  if (goujiMode) {
    // Not the opposite: only a burn is possible, handled by chooseBurn.
    return chooseBurn(game, seat) ?? { kind: "pass" };
  }
  // Normal follow: beat cheaply, or pass.
  const cheap = beats.filter((pl) => pl.wildCount === 0 && !pl.isGouji);
  const finishing = hand.length <= 8;
  const leaderAboutToWin =
    game.player(current.seat).hand.length <= 5;
  if (cheap.length > 0 && (finishing || leaderAboutToWin || cheap[0].total <= 2)) {
    return { kind: "play", cardIds: cheap[0].cards.map((c) => c.id) };
  }
  if (finishing && beats.length > 0) {
    return { kind: "play", cardIds: beats[0].cards.map((c) => c.id) };
  }
  return { kind: "pass" };
}

function chooseBurn(game: Game, seat: number): PlayerAction | null {
  const hand = game.player(seat).hand;
  const p = game.player(seat);
  const current = game.currentPlay;
  if (!current || !p.opened) return null;
  const beats = usablePlays(game, seat, current.play).filter((pl) => pl.isGouji);
  if (beats.length === 0) return null;
  // Need a joker for every remaining play after the burn play, except the last.
  // Remaining plays are counted by distinct rank groups (2s form their own
  // group, and a 4-group cannot carry a joker, so it must be the final play).
  const rest = hand.filter((c) => !beats[0].cards.includes(c));
  const groups = new Set(rest.map((c) => c.rank));
  const jokersLeft = rest.filter(
    (c) => c.rank === "small-joker" || c.rank === "big-joker" || c.rank === "eagle"
  ).length;
  if (rest.length === 0) return { kind: "burn", cardIds: beats[0].cards.map((c) => c.id) };
  if (groups.size > 1 && jokersLeft < groups.size - 1) return null;
  if (groups.has("4") && groups.size > 1) return null;
  // Only burn when the Gouji player is dangerous (few cards left) or we are close to finishing.
  const targetHand = game.player(current.seat).hand.length;
  if (targetHand > 10 && hand.length > 12) return null;
  return { kind: "burn", cardIds: beats[0].cards.map((c) => c.id) };
}

/** Decide one bot action. Returns null when the bot has nothing to do. */
export function botAction(game: Game, seat: number): PlayerAction | null {
  const p = game.player(seat);
  if (game.phase === "revolution") {
    if (game.revolutionEligible.includes(seat)) {
      return { kind: "revolution", declare: true };
    }
    return null;
  }
  if (game.phase !== "playing") return null;
  const current = game.currentPlay;
  // Burn interrupts: if a Gouji card is on the table and this bot is not the
  // opposite, it may burn even though it is not its turn.
  if (
    current && current.play.isGouji && game.finishedCount() < 2 &&
    seat !== current.seat && seat !== game.goujiOpposite &&
    !game.passed.has(seat) && p.opened
  ) {
    const burn = chooseBurn(game, seat);
    if (burn) return burn;
    // If the opposite has already let/passed, the bot may be asked to act.
    if (game.turnSeat !== seat) return null;
  }
  if (game.turnSeat !== seat) return null;
  if (!current) return chooseLead(game, seat);
  return chooseFollow(game, seat);
}

/** Suggest a legal play for a human (hint button). Returns card ids or null. */
export function suggestPlay(game: Game, seat: number): string[] | null {
  const current = game.currentPlay;
  const action = current ? chooseFollow(game, seat) : chooseLead(game, seat);
  if (!action || action.kind !== "play") return null;
  return action.cardIds;
}

export function parseHintPlay(hand: Card[], cardIds: string[]): PlayInfo | null {
  const cards = cardIds
    .map((id) => hand.find((c) => c.id === id))
    .filter((c): c is Card => c !== undefined);
  if (cards.length !== cardIds.length) return null;
  return parsePlay(cards);
}

export type { RankId };
export { rankIndex };
