import { describe, expect, test } from "bun:test";
import { Game } from "../src/engine/game.ts";
import type { PlayerAction } from "../src/engine/game.ts";
import { botAction } from "../src/engine/ai.ts";
import { buildDeck, parsePlay, beats } from "../src/engine/play.ts";
import { federationScore, seatRelation } from "../src/engine/types.ts";
import type { Card, RankId } from "../src/engine/types.ts";

function card(rank: RankId, suit = "♠", deck = 0, id?: string): Card {
  return { id: id ?? `${rank}${suit}${deck}${Math.random()}`, rank, suit, deck };
}

function handOf(rank: RankId, n: number, suit = "♠"): Card[] {
  return Array.from({ length: n }, (_, i) => card(rank, suit, 0, `${rank}-${i}`));
}

function makeGame(): Game {
  const game = new Game("TEST", { decks: "classic4", eagleMode: "king" });
  for (let seat = 1; seat <= 6; seat++) {
    game.addPlayer(seat, `P${seat}`, true, null);
  }
  return game;
}

/** Drive a full game with 6 bots. Returns the finished game. */
function driveBots(game: Game, maxSteps = 20000): Game {
  let steps = 0;
  while (game.phase !== "round-end" && steps < maxSteps) {
    steps++;
    game.tick(Date.now());
    if (game.phase === "revolution") {
      for (const seat of game.revolutionEligible) {
        const action = botAction(game, seat);
        if (action) game.act(seat, action);
      }
      continue;
    }
    if (game.phase !== "playing") break;
    game.resolveStuckTurn();
    if (game.phase !== "playing") break;
    let acted = false;
    // Burn interrupts come before the turn player's move.
    for (let seat = 1; seat <= 6; seat++) {
      const legal = game.legalActions(seat);
      if (legal.canBurn) {
        const action = botAction(game, seat);
        if (action && action.kind === "burn") {
          const r = game.act(seat, action);
          if (r.ok) { acted = true; break; }
        }
      }
    }
    if (acted) continue;
    const turn = game.turnSeat;
    if (turn === null) break;
    const action = botAction(game, turn);
    if (!action) break;
    const result = game.act(turn, action);
    if (!result.ok) {
      throw new Error(`bot ${turn} action ${action.kind} rejected: ${result.error}`);
    }
  }
  return game;
}

describe("deck", () => {
  test("classic 4 decks = 216 cards", () => {
    expect(buildDeck({ decks: "classic4", eagleMode: "king" })).toHaveLength(216);
  });
  test("six decks with eagle-king = 330 cards incl. 6 eagles", () => {
    const deck = buildDeck({ decks: "sixEagle", eagleMode: "king" });
    expect(deck).toHaveLength(330);
    expect(deck.filter((c) => c.rank === "eagle")).toHaveLength(6);
  });
  test("six decks eagle-removed = 324 cards, no eagle", () => {
    const deck = buildDeck({ decks: "sixEagle", eagleMode: "removed" });
    expect(deck).toHaveLength(324);
    expect(deck.filter((c) => c.rank === "eagle")).toHaveLength(0);
  });
});

describe("gouji thresholds", () => {
  test("5x10 is Gouji and pure; 4x10 is not", () => {
    expect(parsePlay(handOf("10", 5))!.isGouji).toBe(true);
    expect(parsePlay(handOf("10", 5))!.isPureGouji).toBe(true);
    expect(parsePlay(handOf("10", 4))!.isGouji).toBe(false);
  });
  test("4xJ, 3xQ, 2xK, 2xA qualify; 1x2 and 1x joker qualify", () => {
    expect(parsePlay(handOf("J", 4))!.isGouji).toBe(true);
    expect(parsePlay(handOf("Q", 3))!.isGouji).toBe(true);
    expect(parsePlay(handOf("K", 2))!.isGouji).toBe(true);
    expect(parsePlay(handOf("A", 2))!.isGouji).toBe(true);
    expect(parsePlay(handOf("2", 1))!.isGouji).toBe(true);
    expect(parsePlay(handOf("small-joker", 1))!.isGouji).toBe(true);
    expect(parsePlay(handOf("big-joker", 1))!.isGouji).toBe(true);
  });
  test("joker attached makes any hand Gouji; 2 attached to reach threshold counts", () => {
    expect(parsePlay([...handOf("5", 3), ...handOf("small-joker", 1)])!.isGouji).toBe(true);
    expect(parsePlay([...handOf("10", 3), ...handOf("2", 2)])!.isGouji).toBe(true);
    expect(parsePlay([...handOf("10", 5), ...handOf("2", 1)])!.isGouji).toBe(true);
    expect(parsePlay([...handOf("10", 5), ...handOf("2", 1)])!.isPureGouji).toBe(false);
  });
  test("plain low ranks never qualify", () => {
    expect(parsePlay(handOf("9", 8))!.isGouji).toBe(false);
    expect(parsePlay(handOf("3", 4))!.isGouji).toBe(false);
  });
  test("mixed base ranks and wilds on 3/4 are invalid", () => {
    expect(parsePlay([...handOf("8", 2), ...handOf("9", 1)])).toBeNull();
    expect(parsePlay([...handOf("3", 2), ...handOf("2", 1)])).toBeNull();
    expect(parsePlay([...handOf("4", 2), ...handOf("small-joker", 1)])).toBeNull();
  });
});

describe("beats", () => {
  test("same count, higher rank wins", () => {
    expect(beats(parsePlay(handOf("9", 3))!, parsePlay(handOf("8", 3))!)).toBe(true);
    expect(beats(parsePlay(handOf("8", 3))!, parsePlay(handOf("9", 3))!)).toBe(false);
  });
  test("different base counts cannot beat", () => {
    expect(beats(parsePlay(handOf("9", 4))!, parsePlay(handOf("8", 3))!)).toBe(false);
  });
  test("joker-attached beats plain same-base play", () => {
    const a = parsePlay([...handOf("8", 3), ...handOf("small-joker", 1)])!;
    const b = parsePlay(handOf("9", 3))!;
    expect(beats(a, b)).toBe(true);
  });
  test("two big jokers beat one big joker (大王二杀一)", () => {
    expect(beats(parsePlay(handOf("big-joker", 2))!, parsePlay(handOf("big-joker", 1))!)).toBe(true);
    expect(beats(parsePlay(handOf("big-joker", 1))!, parsePlay(handOf("big-joker", 2))!)).toBe(false);
  });
  test("eagle-king beats big joker", () => {
    expect(beats(parsePlay(handOf("eagle", 1))!, parsePlay(handOf("big-joker", 1))!)).toBe(true);
  });
  test("2 attached does not raise the rank", () => {
    const a = parsePlay([...handOf("10", 5), ...handOf("2", 2)])!;
    const b = parsePlay(handOf("J", 5))!;
    expect(beats(a, b)).toBe(false);
    expect(beats(b, a)).toBe(true);
  });
});

describe("scoring helpers", () => {
  test("federation score with 串三户 doubles to 12", () => {
    expect(federationScore(["头科", "二科", "三科"])).toEqual({ valid: true, raw: 6, doubled: true, total: 12 });
  });
  test("negative federation total is recorded as 0", () => {
    expect(federationScore(["二落", "大落", "四科"]).total).toBe(0);
  });
  test("seat relations: opposite and teammates", () => {
    expect(seatRelation(1)).toEqual({ seat: 1, opposite: 4, teammates: [3, 5] });
    expect(seatRelation(3)?.opposite).toBe(6);
  });
});

describe("game flow", () => {
  test("a full 6-bot game finishes with distinct ranks and consistent scores", () => {
    const game = makeGame();
    for (let seat = 1; seat <= 6; seat++) game.setReady(seat);
    expect(game.phase).not.toBe("lobby");
    driveBots(game);
    expect(game.phase).toBe("round-end");
    const ranks = game.players.map((p) => p.finishedRank);
    expect(new Set(ranks).size).toBe(6);
    expect(game.roundScores).not.toBeNull();
    const fedA = game.players.filter((p) => p.seat % 2 === 1).map((p) => p.finishedRank!);
    const fedB = game.players.filter((p) => p.seat % 2 === 0).map((p) => p.finishedRank!);
    expect(game.roundScores!.fedA).toBe(federationScore(fedA).total);
    expect(game.roundScores!.fedB).toBe(federationScore(fedB).total);
    expect(game.scores.A + game.scores.B).toBe(game.roundScores!.fedA + game.roundScores!.fedB);
    expect(game.players.every((p) => p.hand.length === 0)).toBe(true);
  });

  test("illegal plays are rejected: out of turn, 3s not last, non-opposite on Gouji", () => {
    const game = makeGame();
    for (let seat = 1; seat <= 6; seat++) game.setReady(seat);
    // If the deal produced revolution-eligible players, advance past the
    // 15 s revolution deadline so the game reaches the playing phase.
    game.tick(Date.now() + 20000);
    const leader = game.turnSeat!;
    expect(leader).not.toBeNull();
    const leaderPlayer = game.player(leader);
    const threes = leaderPlayer.hand.filter((c) => c.rank === "3");
    if (threes.length > 0 && leaderPlayer.hand.length > threes.length) {
      const r = game.act(leader, { kind: "play", cardIds: threes.slice(0, 1).map((c) => c.id) });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("3");
    }
    const other = leader === 1 ? 2 : 1;
    const otherHand = game.player(other).hand;
    const r2 = game.act(other, { kind: "play", cardIds: [otherHand[0].id] });
    expect(r2.ok).toBe(false);
    const r3 = game.act(leader, { kind: "pass" });
    expect(r3.ok).toBe(false);
  });

  test("revolution: an eligible bot declares and is ranked 四科", () => {
    const game = makeGame();
    for (let seat = 1; seat <= 6; seat++) game.setReady(seat);
    game.phase = "revolution";
    game.revolutionEligible = [2];
    game.revolutionEndsAt = Date.now() + 1000;
    const r = game.act(2, { kind: "revolution", declare: true });
    expect(r.ok).toBe(true);
    expect(game.player(2).revolution).toBe(true);
    expect(game.player(2).finishedRank).toBe("四科");
    expect(game.phase as string).toBe("playing");
  });

  test("tributes are applied at the next round and cleared", () => {
    const game = makeGame();
    for (let seat = 1; seat <= 6; seat++) game.setReady(seat);
    driveBots(game);
    expect(game.phase).toBe("round-end");
    expect(game.tributes.length).toBeGreaterThan(0);
    const tributeKinds = game.tributes.map((t) => t.kind);
    expect(tributeKinds).toContain("落贡");
    const logBefore = game.log.join("\n");
    const r = game.act(1, { kind: "next-round" });
    expect(r.ok).toBe(true);
    expect(game.round).toBe(2);
    expect(game.tributes).toHaveLength(0);
    expect(game.log.join("\n")).not.toBe(logBefore);
  });
});

describe("burn and open-point", () => {
  test("a bigger Gouji card burns, and the burner is recorded", () => {
    const game = makeGame();
    for (let seat = 1; seat <= 6; seat++) game.setReady(seat);
    // Rig hands: seat 1 leads 5x10; seat 3 (not opposite) holds 5xJ + jokers and is opened.
    const p1 = game.player(1);
    const p3 = game.player(3);
    p1.hand = [...handOf("10", 5, "♠"), ...handOf("4", 1), ...handOf("3", 2)];
    p3.hand = [...handOf("J", 5, "♥"), ...handOf("small-joker", 2), ...handOf("5", 3)];
    p1.opened = true;
    p3.opened = true;
    game.phase = "playing";
    game.currentPlay = null;
    game.turnSeat = 1;
    const lead = game.act(1, { kind: "play", cardIds: p1.hand.slice(0, 5).map((c) => c.id) });
    expect(lead.ok).toBe(true);
    expect(game.goujiOpposite).toBe(4);
    const burn = game.act(3, { kind: "burn", cardIds: p3.hand.slice(0, 5).map((c) => c.id) });
    expect(burn.ok).toBe(true);
    expect(game.burn).toEqual({ seat: 3, targetSeat: 1 });
    expect(game.player(3).burnActive).toBe(true);
    expect(game.currentPlay!.seat).toBe(3);
    expect(game.turnSeat).toBe(6); // burner's opposite
  });

  test("unopened player cannot burn", () => {
    const game = makeGame();
    for (let seat = 1; seat <= 6; seat++) game.setReady(seat);
    const p1 = game.player(1);
    const p3 = game.player(3);
    p1.hand = [...handOf("10", 5, "♠"), ...handOf("4", 1), ...handOf("3", 2)];
    p3.hand = [...handOf("J", 5, "♥"), ...handOf("small-joker", 2), ...handOf("5", 3)];
    p1.opened = true;
    p3.opened = false;
    game.phase = "playing";
    game.currentPlay = null;
    game.turnSeat = 1;
    expect(game.act(1, { kind: "play", cardIds: p1.hand.slice(0, 5).map((c) => c.id) }).ok).toBe(true);
    const burn = game.act(3, { kind: "burn", cardIds: p3.hand.slice(0, 5).map((c) => c.id) });
    expect(burn.ok).toBe(false);
    expect(burn.error).toContain("开点");
  });

  test("pure Gouji surviving its trick makes the player pending-open, then a 4 opens them", () => {
    const game = makeGame();
    for (let seat = 1; seat <= 6; seat++) game.setReady(seat);
    const p1 = game.player(1);
    // Seat 1: 5x10 + a 4 + low cards. Everyone else: low cards only, no jokers/2s to beat.
    p1.hand = [...handOf("10", 5, "♠"), ...handOf("4", 1), ...handOf("6", 2), ...handOf("3", 2)];
    for (let seat = 2; seat <= 6; seat++) {
      game.player(seat).hand = [...handOf("5", 4, "♥"), ...handOf("6", 4, "♦"), ...handOf("7", 4, "♣")];
      game.player(seat).opened = true;
    }
    p1.opened = false;
    game.phase = "playing";
    game.currentPlay = null;
    game.turnSeat = 1;
    const lead = game.act(1, { kind: "play", cardIds: p1.hand.slice(0, 5).map((c) => c.id) });
    expect(lead.ok).toBe(true);
    // Opposite (seat 4) cannot beat 5x10 with 4x7s; drive the rest with bots.
    let steps = 0;
    while (game.turnSeat !== 1 && steps < 50) {
      steps++;
      const turn = game.turnSeat!;
      const action = botAction(game, turn);
      if (!action) break;
      const r = game.act(turn, action);
      if (!r.ok) break;
    }
    expect(game.player(1).pendingOpen).toBe(true);
    expect(game.turnSeat).toBe(1);
    const four = game.player(1).hand.find((c) => c.rank === "4")!;
    const open = game.act(1, { kind: "play", cardIds: [four.id] });
    expect(open.ok).toBe(true);
    expect(game.player(1).opened).toBe(true);
    expect(game.player(1).pendingOpen).toBe(false);
  });
});
