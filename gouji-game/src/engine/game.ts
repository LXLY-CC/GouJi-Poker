/**
 * Authoritative Gouji state machine. Shared by the server and the local
 * vs-AI client. The server is authoritative online; the client only runs
 * this locally for vs-AI mode.
 *
 * Rules follow demos/gouji-guide (classic 4-deck, 6 players, 2 federations).
 * Simplifications (also listed in the README):
 * - 买3 is not implemented: a player without 3s just plays normally.
 * - 革命 assigns 四科, then 二落, then 大落 in seat order; a 4th
 *   revolutionary is declined (ranks are unique).
 * - A burner's pass ends the burn without penalty; an illegal (joker-less,
 *   non-final) burn play is rejected instead of forcing 大落.
 * - Tribute cards are chosen automatically (largest joker/2/eagle first);
 *   a tribute is waived when the payer holds no joker/2/eagle.
 * - 开点 uses the guide's main rule: a pure Gouji card that survives its
 *   trick makes the player pending-open; they must then lead a 4 (if they
 *   hold one) to complete the opening. No pure Gouji card at deal means
 *   自然点 (already opened).
 */
import {
  RANK_NAMES, federationScore, seatRelation,
} from "./types.ts";
import {
  bestThreeSuit, buildDeck, enumeratePlays,
  hasPureGoujiCard, parsePlay, shuffle, beats,
} from "./play.ts";
import type { PlayInfo } from "./play.ts";
import type {
  Card, GameOptions, RankId, RankName,
} from "./types.ts";

export type Phase = "lobby" | "revolution" | "playing" | "round-end";

export interface PlayerState {
  seat: number;
  name: string;
  isBot: boolean;
  userId: string | null;
  hand: Card[];
  opened: boolean;
  pendingOpen: boolean;
  openCandidate: boolean;
  finishedRank: RankName | null;
  revolution: boolean;
  burnActive: boolean;
  muffledBy: number | null;
  ready: boolean;
  connected: boolean;
}

export interface Tribute {
  kind: "闷贡" | "烧贡" | "点贡" | "落贡";
  from: number;
  to: number;
  count: number;
  paid: number;
  waived: boolean;
}

export interface RoundScores {
  fedA: number;
  fedB: number;
  doubled: boolean;
  ranks: Record<number, RankName>;
}

export interface PublicState {
  roomCode: string;
  options: GameOptions;
  phase: Phase;
  round: number;
  seats: {
    seat: number; name: string; isBot: boolean; handCount: number;
    opened: boolean; pendingOpen: boolean;
    finishedRank: RankName | null; revolution: boolean; ready: boolean;
    connected: boolean;
  }[];
  turnSeat: number | null;
  currentPlay: { seat: number; cards: Card[]; isGouji: boolean; isPure: boolean } | null;
  passed: number[];
  goujiOpposite: number | null;
  burn: { seat: number; targetSeat: number } | null;
  pendingFinish: number[];
  demoted: number[];
  scores: { A: number; B: number };
  roundScores: RoundScores | null;
  tributes: Tribute[];
  log: string[];
  revolutionEligible: number[];
  revolutionEndsAt: number | null;
  leaderSeat: number | null;
}

export type PlayerAction =
  | { kind: "play"; cardIds: string[] }
  | { kind: "burn"; cardIds: string[] }
  | { kind: "pass" }
  | { kind: "let" }
  | { kind: "revolution"; declare: boolean }
  | { kind: "ready" }
  | { kind: "next-round" };

export interface LegalActions {
  canPlay: boolean;
  canPass: boolean;
  canBurn: boolean;
  canLet: boolean;
  canRevolution: boolean;
  hintCardIds: string[] | null;
}

const BOT_NAMES = ["AI·阿强", "AI·小芳", "AI·大壮", "AI·秀英", "AI·建国", "AI·春花"];

function nextSeat(seat: number): number {
  // Seats are numbered clockwise; play goes counter-clockwise.
  return seat === 1 ? 6 : seat - 1;
}

function prevSeat(seat: number): number {
  return seat === 6 ? 1 : seat + 1;
}

export class Game {
  readonly roomCode: string;
  readonly options: GameOptions;
  phase: Phase = "lobby";
  round = 0;
  players: PlayerState[] = [];
  turnSeat: number | null = null;
  currentPlay: { seat: number; play: PlayInfo } | null = null;
  passed = new Set<number>();
  goujiOpposite: number | null = null;
  burn: { seat: number; targetSeat: number } | null = null;
  pendingFinish: number[] = [];
  demoted: { seat: number; beatenBy: number }[] = [];
  scores = { A: 0, B: 0 };
  roundScores: RoundScores | null = null;
  tributes: Tribute[] = [];
  log: string[] = [];
  revolutionEligible: number[] = [];
  revolutionEndsAt: number | null = null;
  private revolutionResponded = new Set<number>();
  private revolutionDeclared = new Set<number>();
  private burnSuccess: { burner: number; target: number }[] = [];
  private rng: () => number;

  constructor(roomCode: string, options: GameOptions, rng: () => number = Math.random) {
    this.roomCode = roomCode;
    this.options = options;
    this.rng = rng;
    for (let seat = 1; seat <= 6; seat++) {
      this.players.push({
        seat, name: "", isBot: false, userId: null, hand: [],
        opened: false, pendingOpen: false, openCandidate: false,
        finishedRank: null, revolution: false, burnActive: false,
        muffledBy: null, ready: false, connected: true,
      });
    }
  }

  player(seat: number): PlayerState {
    return this.players[seat - 1];
  }

  filledSeats(): number {
    return this.players.filter((p) => p.name !== "").length;
  }

  addPlayer(seat: number, name: string, isBot: boolean, userId: string | null): boolean {
    const p = this.player(seat);
    if (p.name !== "" || this.phase !== "lobby") return false;
    p.name = name;
    p.isBot = isBot;
    p.userId = userId;
    this.pushLog(`${name} 坐到 ${seat} 号位`);
    return true;
  }

  removePlayer(seat: number): void {
    const p = this.player(seat);
    if (this.phase !== "lobby") return;
    p.name = "";
    p.isBot = false;
    p.userId = null;
    p.ready = false;
  }

  fillBots(): void {
    let botIndex = 0;
    for (const p of this.players) {
      if (p.name === "") {
        p.name = BOT_NAMES[botIndex % BOT_NAMES.length];
        p.isBot = true;
        p.ready = true;
        botIndex++;
      }
    }
    this.maybeStart();
  }

  setReady(seat: number): boolean {
    const p = this.player(seat);
    if (this.phase !== "lobby" || p.name === "") return false;
    p.ready = true;
    this.maybeStart();
    return true;
  }

  /** Start round 1 once all six seats are filled and ready. */
  private maybeStart(): void {
    if (this.phase === "lobby" && this.filledSeats() === 6 && this.players.every((x) => x.ready)) {
      this.startRound(1);
    }
  }

  /** Active players: still holding cards and not revolutioned/finished. */
  activeSeats(): number[] {
    return this.players
      .filter((p) => p.hand.length > 0 && !p.revolution && p.finishedRank === null)
      .map((p) => p.seat);
  }

  finishedCount(): number {
    return this.players.filter((p) => p.finishedRank !== null).length;
  }

  private nextRank(): RankName | null {
    for (const rank of RANK_NAMES) {
      if (!this.players.some((p) => p.finishedRank === rank)) return rank;
    }
    return null;
  }

  private pushLog(text: string): void {
    this.log.push(text);
    if (this.log.length > 120) this.log.splice(0, this.log.length - 120);
  }

  // ---- round lifecycle ----

  startRound(round: number): void {
    this.round = round;
    this.roundScores = null;
    this.turnSeat = null;
    this.currentPlay = null;
    this.passed = new Set();
    this.goujiOpposite = null;
    this.burn = null;
    this.pendingFinish = [];
    this.demoted = [];
    this.burnSuccess = [];
    this.revolutionResponded = new Set();
    this.revolutionDeclared = new Set();
    for (const p of this.players) {
      p.hand = [];
      p.opened = false;
      p.pendingOpen = false;
      p.openCandidate = false;
      p.finishedRank = null;
      p.revolution = false;
      p.burnActive = false;
      p.muffledBy = null;
      p.ready = false;
    }
    const deck = shuffle(buildDeck(this.options), this.rng);
    deck.forEach((card, i) => {
      this.players[i % 6].hand.push(card);
    });
    const order = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2", "small-joker", "big-joker", "eagle"];
    for (const p of this.players) {
      p.hand.sort((a, b) => order.indexOf(a.rank) - order.indexOf(b.rank));
    }
    // Tribute exchange from the previous round, then natural-point check.
    this.applyTributes();
    for (const p of this.players) {
      p.opened = !hasPureGoujiCard(p.hand);
      if (p.opened) this.pushLog(`${p.name} 没有开点牌，自然点`);
    }
    // Revolution window.
    this.revolutionEligible = this.players
      .filter((p) => !p.hand.some((c) => c.rank === "2" || c.rank === "small-joker" || c.rank === "big-joker" || c.rank === "eagle"))
      .map((p) => p.seat);
    if (this.revolutionEligible.length > 0) {
      this.phase = "revolution";
      this.revolutionEndsAt = Date.now() + 15000;
      this.pushLog(`第 ${round} 局发牌完毕，可革命的座位：${this.revolutionEligible.join("、")} 号`);
    } else {
      this.beginPlay();
    }
  }

  tick(now: number): boolean {
    if (this.phase === "revolution" && this.revolutionEndsAt !== null && now >= this.revolutionEndsAt) {
      this.finalizeRevolution();
      return true;
    }
    return false;
  }

  private finalizeRevolution(): void {
    // Bots always declare when eligible; humans who did not respond decline.
    for (const seat of this.revolutionEligible) {
      const p = this.player(seat);
      const declares = p.isBot || this.revolutionDeclared.has(seat);
      if (declares) p.revolution = true;
    }
    const revolutionaries = this.players.filter((p) => p.revolution);
    const ranks: RankName[] = ["四科", "二落", "大落"];
    revolutionaries.slice(0, 3).forEach((p, i) => {
      p.finishedRank = ranks[i];
      this.pushLog(`${p.name} 革命，本局按${ranks[i]}论处`);
    });
    if (revolutionaries.length > 3) {
      this.pushLog("革命人数超过 3 人，多余者按正常打牌（名次唯一，无法再安排）");
    }
    this.revolutionEndsAt = null;
    this.beginPlay();
  }

  private beginPlay(): void {
    this.phase = "playing";
    // First leader: most same-suit 3s among active players, tie → lowest seat.
    let leader = -1;
    let best = -1;
    for (const seat of this.activeSeats()) {
      const count = bestThreeSuit(this.player(seat).hand).count;
      if (count > best) { best = count; leader = seat; }
    }
    this.turnSeat = leader;
    this.pushLog(`第 ${this.round} 局开始，${this.player(leader).name}（${leader} 号）亮 3 上班，先出牌`);
    if (this.finishedCount() === 6) this.endRound();
  }

  private applyTributes(): void {
    if (this.tributes.length === 0) return;
    const order: RankId[] = ["eagle", "big-joker", "small-joker", "2", "A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3"];
    const rankValue = (r: RankId) => order.indexOf(r);
    for (const tribute of this.tributes) {
      const from = this.player(tribute.from);
      const to = this.player(tribute.to);
      const payable = from.hand
        .filter((c) => c.rank === "eagle" || c.rank === "big-joker" || c.rank === "small-joker" || c.rank === "2")
        .sort((a, b) => rankValue(a.rank) - rankValue(b.rank));
      const give = payable.slice(0, tribute.count);
      tribute.paid = give.length;
      tribute.waived = give.length === 0;
      if (give.length === 0) {
        this.pushLog(`${from.name} 没有王/2，${tribute.kind}免贡`);
        continue;
      }
      for (const card of give) {
        from.hand.splice(from.hand.indexOf(card), 1);
        to.hand.push(card);
      }
      this.pushLog(`${from.name} 向 ${to.name} 进${tribute.kind} ${give.length} 张（${give.map((c) => c.rank === "eagle" ? "鹰" : c.rank === "big-joker" ? "大王" : c.rank === "small-joker" ? "小王" : "2").join("、")}）`);
      if (tribute.kind === "落贡") {
        const ret = [...to.hand]
          .sort((a, b) => rankValue(b.rank) - rankValue(a.rank))
          .slice(0, give.length);
        for (const card of ret) {
          to.hand.splice(to.hand.indexOf(card), 1);
          from.hand.push(card);
        }
        this.pushLog(`${to.name} 还贡 ${ret.length} 张`);
      }
    }
    this.tributes = [];
  }

  private endRound(): void {
    const ranks: Record<number, RankName> = {};
    for (const p of this.players) ranks[p.seat] = p.finishedRank!;
    const fedA = this.players.filter((p) => p.seat % 2 === 1).map((p) => p.finishedRank!);
    const fedB = this.players.filter((p) => p.seat % 2 === 0).map((p) => p.finishedRank!);
    const scoreA = federationScore(fedA);
    const scoreB = federationScore(fedB);
    this.scores.A += scoreA.total;
    this.scores.B += scoreB.total;
    this.roundScores = {
      fedA: scoreA.total, fedB: scoreB.total,
      doubled: scoreA.doubled || scoreB.doubled, ranks,
    };
    this.pushLog(`第 ${this.round} 局结束：联邦甲 ${scoreA.total} 分，联邦乙 ${scoreB.total} 分${scoreA.doubled || scoreB.doubled ? "（串三户翻倍）" : ""}；累计 ${this.scores.A} : ${this.scores.B}`);
    // Tributes for the next round.
    const next: Tribute[] = [];
    const rankOf = (rank: RankName) => this.players.find((p) => p.finishedRank === rank)!;
    for (const p of this.players) {
      if (p.muffledBy !== null && p.finishedRank === "大落") {
        next.push({ kind: "闷贡", from: p.seat, to: p.muffledBy, count: 1, paid: 0, waived: false });
      }
    }
    for (const { burner, target } of this.burnSuccess) {
      next.push({ kind: "烧贡", from: target, to: burner, count: 1, paid: 0, waived: false });
    }
    for (const p of this.players) {
      if (!p.opened && !p.revolution) {
        next.push({ kind: "点贡", from: p.seat, to: seatRelation(p.seat)!.opposite, count: 1, paid: 0, waived: false });
      }
    }
    next.push({ kind: "落贡", from: rankOf("大落").seat, to: rankOf("头科").seat, count: 2, paid: 0, waived: false });
    next.push({ kind: "落贡", from: rankOf("二落").seat, to: rankOf("二科").seat, count: 1, paid: 0, waived: false });
    this.tributes = next;
    this.phase = "round-end";
    this.turnSeat = null;
    this.currentPlay = null;
  }

  private assignRank(seat: number, rank: RankName): void {
    const p = this.player(seat);
    p.finishedRank = rank;
    p.burnActive = false;
    this.pushLog(`${p.name}（${seat} 号）${rank}`);
    if (this.finishedCount() === 6) this.endRound();
  }

  // ---- actions ----

  act(seat: number, action: PlayerAction): { ok: boolean; error?: string } {
    if (action.kind === "ready") {
      return this.setReady(seat) ? { ok: true } : { ok: false, error: "现在不能准备" };
    }
    if (action.kind === "next-round") {
      if (this.phase !== "round-end") return { ok: false, error: "本局还没结束" };
      this.startRound(this.round + 1);
      return { ok: true };
    }
    if (action.kind === "revolution") {
      if (this.phase !== "revolution") return { ok: false, error: "现在不是革命时间" };
      if (!this.revolutionEligible.includes(seat)) return { ok: false, error: "你没有革命资格" };
      if (this.revolutionResponded.has(seat)) return { ok: false, error: "你已经表态过了" };
      this.revolutionResponded.add(seat);
      if (action.declare) this.revolutionDeclared.add(seat);
      const humansPending = this.revolutionEligible.filter(
        (s) => !this.player(s).isBot && !this.revolutionResponded.has(s)
      );
      if (humansPending.length === 0) this.finalizeRevolution();
      return { ok: true };
    }
    if (this.phase !== "playing") return { ok: false, error: "现在不是出牌时间" };
    if (action.kind === "pass") return this.doPass(seat);
    if (action.kind === "let") return this.doLet(seat);
    if (action.kind === "play") return this.doPlay(seat, action.cardIds, false);
    if (action.kind === "burn") return this.doPlay(seat, action.cardIds, true);
    return { ok: false, error: "未知操作" };
  }

  // ---- playing ----

  private doPlay(seat: number, cardIds: string[], isBurn: boolean): { ok: boolean; error?: string } {
    const p = this.player(seat);
    if (!this.activeSeats().includes(seat)) return { ok: false, error: "你不在牌局中" };
    const cards = cardIds.map((id) => p.hand.find((c) => c.id === id)).filter((c): c is Card => c !== undefined);
    if (cards.length !== cardIds.length) return { ok: false, error: "手里没有这张牌" };
    const play = parsePlay(cards);
    if (!play) return { ok: false, error: "这手牌型不合法（同点才能一起出，3/4 不能挂牌）" };
    const after = p.hand.length - cards.length;
    if (play.cards.some((c) => c.rank === "3") && after !== 0) {
      return { ok: false, error: "3 必须留到最后一手才能出（憋3）" };
    }
    const current = this.currentPlay;
    if (isBurn) {
      if (!current || !current.play.isGouji) return { ok: false, error: "现在没有够级牌可烧" };
      if (this.finishedCount() >= 2) return { ok: false, error: "四户乱缠阶段不能烧牌" };
      if (seat === current.seat) return { ok: false, error: "不能烧自己的牌" };
      if (seat === this.goujiOpposite) return { ok: false, error: "对头请直接压牌，不要烧" };
      if (!p.opened) return { ok: false, error: "没开点不能烧牌" };
      if (this.passed.has(seat)) return { ok: false, error: "你这轮已经过牌了" };
      if (!play.isGouji) return { ok: false, error: "烧牌必须用够级牌" };
      if (!beats(play, current.play)) return { ok: false, error: "烧牌要用更大的够级牌盖住" };
    } else {
      if (this.turnSeat !== seat) return { ok: false, error: "还没轮到你" };
      if (current) {
        const goujiMode = current.play.isGouji && this.finishedCount() < 2;
        if (goujiMode && seat !== this.goujiOpposite) {
          return { ok: false, error: "够级牌只有对头能接（想搅局请烧牌）" };
        }
        if (!beats(play, current.play)) {
          return { ok: false, error: "压不起：张数要和上家一致、点数要更大" };
        }
      } else if (p.pendingOpen) {
        const hasFour = p.hand.some((c) => c.rank === "4");
        if (hasFour && !play.cards.some((c) => c.rank === "4")) {
          return { ok: false, error: "开点要先发一张 4" };
        }
      }
      if (p.burnActive && after !== 0 && play.smallCount + play.bigCount + play.eagleCount === 0) {
        return { ok: false, error: "烧牌期间每手牌都必须挂一张王（最后一手除外）" };
      }
    }
    // Apply the play.
    for (const card of cards) p.hand.splice(p.hand.indexOf(card), 1);
    if (p.pendingOpen && current === null) {
      p.opened = true;
      p.pendingOpen = false;
      this.pushLog(`${p.name} 发 4 开点`);
    }
    if (play.isPureGouji) p.openCandidate = true;
    if (isBurn) {
      this.burn = { seat, targetSeat: current!.seat };
      p.burnActive = true;
      this.pushLog(`${p.name} 烧了 ${this.player(current!.seat).name} 的够级牌！`);
    }
    // If the play being beaten belonged to a player who just emptied their
    // hand, that finisher is demoted (and muffled if the beater is opposite).
    if (current && this.pendingFinish.includes(current.seat)) {
      this.demoteFinisher(current.seat, seat);
    }
    // If a burn play is beaten, the burn is broken (解烧).
    if (current && this.burn && current.seat === this.burn.seat) {
      this.player(current.seat).burnActive = false;
      this.pushLog(`${this.player(current.seat).name} 的烧牌被 ${p.name} 解了`);
      this.burn = null;
    }
    const finished = p.hand.length === 0;
    if (finished) {
      this.pendingFinish.push(seat);
      this.pushLog(`${p.name} 出完了最后一手牌，底牌${play.isGouji ? "是够级牌" : ""}，等对面表态`);
    }
    this.currentPlay = { seat, play };
    this.passed = new Set();
    const goujiMode = play.isGouji && this.finishedCount() < 2;
    if (goujiMode) {
      const opp = seatRelation(seat)!.opposite;
      const oppPlayer = this.player(opp);
      this.goujiOpposite = oppPlayer.hand.length > 0 && !oppPlayer.revolution && oppPlayer.finishedRank === null ? opp : null;
      if (this.goujiOpposite !== null) {
        this.pushLog(`${p.name} 打出够级牌，轮到对头 ${oppPlayer.name} 接牌`);
      }
    } else {
      this.goujiOpposite = null;
    }
    if (finished) {
      // The finisher's last play must survive one round of responses.
      if (!this.hasResponder()) this.endTrick();
      else this.turnSeat = this.nextResponder(seat);
    } else if (goujiMode) {
      if (this.goujiOpposite !== null) this.turnSeat = this.goujiOpposite;
      else this.endTrick();
    } else {
      const next = this.nextResponder(seat);
      if (next === null) this.endTrick();
      else this.turnSeat = next;
    }
    return { ok: true };
  }

  private doPass(seat: number): { ok: boolean; error?: string } {
    if (this.turnSeat !== seat) return { ok: false, error: "还没轮到你" };
    if (!this.currentPlay) return { ok: false, error: "你是领出者，不能过牌" };
    const p = this.player(seat);
    if (p.burnActive) {
      p.burnActive = false;
      this.pushLog(`${p.name} 过牌，烧牌中断`);
    }
    this.passed.add(seat);
    this.pushLog(`${p.name} 过`);
    if (!this.hasResponder()) this.endTrick();
    else this.turnSeat = this.nextResponder(this.currentPlay.seat);
    return { ok: true };
  }

  private doLet(seat: number): { ok: boolean; error?: string } {
    if (this.turnSeat !== seat) return { ok: false, error: "还没轮到你" };
    if (!this.currentPlay || !this.currentPlay.play.isGouji) {
      return { ok: false, error: "只有对头打出的够级牌才能让" };
    }
    if (seat !== this.goujiOpposite) return { ok: false, error: "只有对头能让牌" };
    this.passed.add(seat);
    this.pushLog(`${this.player(seat).name} 让牌，先看其他人表态`);
    if (!this.hasResponder()) this.endTrick();
    else this.turnSeat = this.nextResponder(this.currentPlay.seat);
    return { ok: true };
  }

  /** Is there anyone who may still respond to the current play? */
  private hasResponder(): boolean {
    if (!this.currentPlay) return false;
    const leader = this.currentPlay.seat;
    for (const seat of this.activeSeats()) {
      if (seat === leader || this.passed.has(seat)) continue;
      if (this.currentPlay.play.isGouji && this.finishedCount() < 2) {
        if (seat === this.goujiOpposite) return true;
        // Anyone else may still burn if opened.
        if (this.player(seat).opened) return true;
        continue;
      }
      return true;
    }
    return false;
  }

  /** Next seat that may act, scanning counter-clockwise from `from`. */
  private nextResponder(from: number): number | null {
    if (!this.currentPlay) return null;
    const goujiMode = this.currentPlay.play.isGouji && this.finishedCount() < 2;
    if (goujiMode) {
      if (this.goujiOpposite !== null && !this.passed.has(this.goujiOpposite)) {
        return this.goujiOpposite;
      }
      // Opposite has passed/let: anyone opened may burn.
      let seat = nextSeat(from);
      for (let i = 0; i < 6; i++) {
        if (this.activeSeats().includes(seat) && !this.passed.has(seat) && seat !== this.currentPlay.seat) {
          if (this.player(seat).opened) return seat;
        }
        seat = nextSeat(seat);
      }
      return null;
    }
    let seat = nextSeat(from);
    for (let i = 0; i < 6; i++) {
      if (this.activeSeats().includes(seat) && !this.passed.has(seat) && seat !== this.currentPlay.seat) {
        return seat;
      }
      seat = nextSeat(seat);
    }
    return null;
  }

  private endTrick(): void {
    if (!this.currentPlay) return;
    const leaderSeat = this.currentPlay.seat;
    const leader = this.player(leaderSeat);
    const wasPure = this.currentPlay.play.isPureGouji;
    const wasBurner = this.burn && this.burn.seat === leaderSeat;
    // The leader's pure Gouji card survived: they are pending-open.
    if (wasPure && leader.hand.length > 0 && !leader.opened) {
      leader.pendingOpen = true;
    }
    if (wasPure && leader.hand.length === 0) leader.opened = true;
    // Burn success: the burner finished while the burn was live.
    if (wasBurner && leader.hand.length === 0 && leader.burnActive) {
      this.burnSuccess.push({ burner: leaderSeat, target: this.burn!.targetSeat });
      this.pushLog(`${leader.name} 烧牌成功！${this.player(this.burn!.targetSeat).name} 下局要进烧贡`);
    }
    if (leader.burnActive && leader.hand.length === 0) leader.burnActive = false;
    // Resolve the finisher whose last play stood.
    if (this.pendingFinish.includes(leaderSeat)) {
      this.pendingFinish = this.pendingFinish.filter((s) => s !== leaderSeat);
      const rank = this.nextRank();
      if (rank) this.assignRank(leaderSeat, rank);
    }
    // Demoted finishers take the ranks after the next finisher.
    while (this.demoted.length > 0) {
      const entry = this.demoted.shift()!;
      const rank = this.nextRank();
      if (!rank) break;
      this.assignRank(entry.seat, rank);
    }
    this.currentPlay = null;
    this.passed = new Set();
    this.goujiOpposite = null;
    this.burn = null;
    if (this.phase !== "playing") return;
    // Next leader: the trick winner, or the next active player after them.
    let next = leaderSeat;
    for (let i = 0; i < 6; i++) {
      if (this.activeSeats().includes(next)) {
        this.turnSeat = next;
        break;
      }
      next = nextSeat(next);
    }
    if (this.turnSeat === null && !this.activeSeats().includes(leaderSeat)) {
      // No one left with cards: close the round out.
      if (this.activeSeats().length === 0) {
        this.turnSeat = null;
        this.closeOutRound();
        return;
      }
    }
    // A stuck burner to lead fails the burn instead of stalling the game.
    for (let i = 0; i < 6; i++) {
      if (!this.resolveStuckTurn()) break;
      if (this.phase !== "playing") return;
    }
  }

  /**
   * If the player to lead is mid-burn but holds no legal joker-carrying play
   * (and cannot finish in one play), the burn fails: they take the worst
   * free rank and sit out, per the guide ("烧失败，按大落论处").
   * Returns true when a burn failed and the turn moved on.
   */
  resolveStuckTurn(): boolean {
    if (this.phase !== "playing" || this.turnSeat === null || this.currentPlay !== null) {
      return false;
    }
    const p = this.player(this.turnSeat);
    if (!p.burnActive) return false;
    const plays = enumeratePlays(p.hand, null).filter(
      (pl) => pl.total === p.hand.length || pl.smallCount + pl.bigCount + pl.eagleCount > 0
    );
    if (plays.length > 0) return false;
    const worst = [...RANK_NAMES].reverse().find(
      (r) => !this.players.some((x) => x.finishedRank === r)
    );
    p.hand = [];
    p.burnActive = false;
    this.pushLog(`${p.name} 烧牌断了王，按${worst ?? "大落"}论处，本局不再出牌`);
    if (worst) this.assignRank(p.seat, worst);
    if (this.phase !== "playing") return true;
    // Move the lead to the next active player, or close the round out.
    let next = nextSeat(p.seat);
    let found: number | null = null;
    for (let i = 0; i < 6; i++) {
      if (this.activeSeats().includes(next)) { found = next; break; }
      next = nextSeat(next);
    }
    this.turnSeat = found;
    if (found === null) this.closeOutRound();
    return true;
  }

  /** Assign remaining ranks when no one can play any more (safety net). */
  private closeOutRound(): void {
    while (this.pendingFinish.length > 0) {
      const seat = this.pendingFinish.shift()!;
      const rank = this.nextRank();
      if (!rank) break;
      this.assignRank(seat, rank);
    }
    while (this.demoted.length > 0) {
      const entry = this.demoted.shift()!;
      const rank = this.nextRank();
      if (!rank) break;
      this.assignRank(entry.seat, rank);
    }
    for (const pl of this.players) {
      if (pl.finishedRank === null) {
        const rank = this.nextRank();
        if (!rank) break;
        this.assignRank(pl.seat, rank);
      }
    }
  }

  /** Called when a pending finisher's last play is beaten. */
  private demoteFinisher(seat: number, beatenBy: number): void {
    this.pendingFinish = this.pendingFinish.filter((s) => s !== seat);
    const p = this.player(seat);
    if (beatenBy === seatRelation(seat)!.opposite) {
      p.muffledBy = beatenBy;
      this.pushLog(`${p.name} 的底牌被对头 ${this.player(beatenBy).name} 压住，被闷了！`);
    } else {
      this.pushLog(`${p.name} 的底牌被 ${this.player(beatenBy).name} 压住，名次延后`);
    }
    this.demoted.push({ seat, beatenBy });
  }

  // ---- views ----

  legalActions(seat: number): LegalActions {
    const p = this.player(seat);
    const base: LegalActions = {
      canPlay: false, canPass: false, canBurn: false,
      canLet: false, canRevolution: false, hintCardIds: null,
    };
    if (this.phase === "revolution") {
      base.canRevolution =
        this.revolutionEligible.includes(seat) && !this.revolutionResponded.has(seat);
      return base;
    }
    if (this.phase !== "playing" || !this.activeSeats().includes(seat)) return base;
    const current = this.currentPlay;
    if (current && current.play.isGouji && this.finishedCount() < 2) {
      if (seat === this.goujiOpposite && this.turnSeat === seat) {
        base.canPlay = true;
        base.canPass = true;
        base.canLet = true;
      }
      if (
        seat !== current.seat && seat !== this.goujiOpposite &&
        !this.passed.has(seat) && p.opened && this.canBeatGouji(seat)
      ) {
        base.canBurn = true;
      }
    } else if (this.turnSeat === seat) {
      base.canPlay = true;
      base.canPass = current !== null;
    }
    return base;
  }

  private canBeatGouji(seat: number): boolean {
    if (!this.currentPlay) return false;
    const plays = enumeratePlays(this.player(seat).hand, this.currentPlay.play);
    return plays.some((play) => play.isGouji);
  }

  snapshotFor(seat: number): PublicState & { hand: Card[]; legal: LegalActions } {
    const state = this.publicState();
    return {
      ...state,
      hand: this.player(seat).hand.map((c) => ({ ...c })),
      legal: this.legalActions(seat),
    };
  }

  publicState(): PublicState {
    return {
      roomCode: this.roomCode,
      options: { ...this.options },
      phase: this.phase,
      round: this.round,
      seats: this.players.map((p) => ({
        seat: p.seat, name: p.name, isBot: p.isBot, handCount: p.hand.length,
        opened: p.opened, pendingOpen: p.pendingOpen,
        finishedRank: p.finishedRank, revolution: p.revolution,
        ready: p.ready, connected: p.connected,
      })),
      turnSeat: this.turnSeat,
      currentPlay: this.currentPlay
        ? {
            seat: this.currentPlay.seat,
            cards: this.currentPlay.play.cards.map((c) => ({ ...c })),
            isGouji: this.currentPlay.play.isGouji,
            isPure: this.currentPlay.play.isPureGouji,
          }
        : null,
      passed: [...this.passed],
      goujiOpposite: this.goujiOpposite,
      burn: this.burn ? { ...this.burn } : null,
      pendingFinish: [...this.pendingFinish],
      demoted: this.demoted.map((d) => d.seat),
      scores: { ...this.scores },
      roundScores: this.roundScores ? { ...this.roundScores, ranks: { ...this.roundScores.ranks } } : null,
      tributes: this.tributes.map((t) => ({ ...t })),
      log: [...this.log],
      revolutionEligible: [...this.revolutionEligible],
      revolutionEndsAt: this.revolutionEndsAt,
      leaderSeat: this.currentPlay ? this.currentPlay.seat : this.turnSeat,
    };
  }
}

