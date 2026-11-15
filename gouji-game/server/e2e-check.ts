// Scripted end-to-end check: one raw WS client + 5 server bots play a full
// Gouji game against the local dev server. Also verifies illegal plays are
// rejected, and that next-round / end-match work.
// Run:  PORT=8787 DEV_MODE=1 bun run index.ts   (in another terminal)
//       bun e2e-check.ts [ROOM]
import { beats, enumeratePlays, parsePlay, rankIndex } from "../src/engine/play.ts";
import type { ClientState } from "../src/engine/protocol.ts";

const ROOM = process.argv[2] ?? "E2E01";
const PORT = process.env.PORT ?? "8787";
const URL = `ws://127.0.0.1:${PORT}/gouji?room=${ROOM}`;
const started = Date.now();
let state: ClientState | null = null;
let youSeat: number | null = null;
let illegalRejected = 0;
let illegalSent = 0;
let roundsSeen = 0;
let lastPhase = "";
let lastLogLen = 0;
let actedThisTurn = 0;
let done = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[e2e ${((Date.now() - started) / 1000).toFixed(1)}s]`, ...a);

function pickMove(): { kind: "play" | "pass" | "let"; cardIds?: string[] } | null {
  if (!state || youSeat === null) return null;
  const me = state.seats.find((p) => p.seat === youSeat)!;
  const hand = state.hand;
  const current = state.currentPlay ? parsePlay(state.currentPlay.cards) : null;
  const isBurner = state.burn?.seat === youSeat;
  if (state.phase === "revolution") {
    return null; // handled separately
  }
  if (state.phase !== "playing" || state.turnSeat !== youSeat) return null;
  const plays = enumeratePlays(hand, current).filter((pl) => {
    if (pl.cards.some((c) => c.rank === "3") && pl.total !== hand.length) return false;
    if (isBurner && pl.total !== hand.length && pl.smallCount + pl.bigCount + pl.eagleCount === 0) return false;
    const hasFour = hand.some((c) => c.rank === "4");
    if (me.pendingOpen && hasFour && !pl.cards.some((c) => c.rank === "4")) return false;
    return true;
  });
  if (!current) {
    if (plays.length === 0) return null;
    plays.sort((a, b) => rankIndex(a.effectiveRank) - rankIndex(b.effectiveRank) || a.total - b.total);
    return { kind: "play", cardIds: plays[0].cards.map((c) => c.id) };
  }
  const beating = plays.filter((pl) => beats(pl, current));
  if (beating.length > 0) {
    beating.sort((a, b) => rankIndex(a.effectiveRank) - rankIndex(b.effectiveRank) || a.total - b.total);
    return { kind: "play", cardIds: beating[0].cards.map((c) => c.id) };
  }
  if (current.isGouji && state.legal.canLet) return { kind: "let" };
  return { kind: "pass" };
}

const ws = new WebSocket(URL);
const send = (msg: unknown) => ws.send(JSON.stringify(msg));

ws.onopen = () => {
  log("connected");
  send({ type: "join", room: ROOM, name: "测试玩家", options: { decks: "classic4", eagleMode: "king", bots: true } });
  // Illegal play #1: fake card id while still in the lobby.
  setTimeout(() => {
    illegalSent++;
    send({ type: "act", action: { kind: "play", cardIds: ["no-such-card"] } });
  }, 500);
};

ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.type === "hello") {
    youSeat = msg.seat;
    log("hello", JSON.stringify(msg));
    send({ type: "ready" });
    log("sent ready");
    return;
  }
  if (msg.type === "error") {
    illegalRejected++;
    log("server error (expected for illegal plays):", msg.message);
    return;
  }
  if (msg.type === "notice") {
    log("notice:", msg.message);
    return;
  }
  if (msg.type !== "state") return;
  state = msg.state as ClientState;
  if (state.phase === "playing") {
    log("state: turn", state.turnSeat, "hands", state.seats.map((p) => p.handCount).join(","), "cur", state.currentPlay ? `${state.currentPlay.seat}:${state.currentPlay.cards.map((c) => c.rank).join("")}` : "-");
  }
  if (state.phase !== lastPhase) {
    log("phase ->", state.phase, "round", state.round);
    lastPhase = state.phase;
    if (state.phase === "round-end") {
      roundsSeen++;
      const ranks = Object.values(state.roundScores?.ranks ?? {});
      log("ROUND END ranks:", JSON.stringify(state.roundScores?.ranks), "fedA:", state.roundScores?.fedA, "fedB:", state.roundScores?.fedB, "doubled:", state.roundScores?.doubled);
      log("cumulative scores:", JSON.stringify(state.scores), "tributes:", JSON.stringify(state.tributes.map((t) => `${t.kind}:${t.from}->${t.to}x${t.count}`)));
      const distinct = new Set(ranks);
      if (ranks.length !== 6 || distinct.size !== 6) {
        log("FAIL: expected 6 distinct finish ranks, got", ranks.length, distinct.size);
        process.exit(2);
      }
      if (illegalRejected === 0) {
        log("FAIL: no illegal play was rejected");
        process.exit(2);
      }
      done = true;
      // One more round-trip: next round starts, then end the match.
      setTimeout(() => {
        send({ type: "next-round" });
        log("sent next-round");
      }, 1000);
      setTimeout(() => {
        send({ type: "end-match" });
        log("sent end-match");
      }, 6000);
      setTimeout(() => {
        log("PASS: full game completed, illegal plays rejected:", illegalRejected);
        process.exit(0);
      }, 9000);
      return;
    }
    if (state.phase === "playing" && done) {
      log("second round started (next-round works)");
    }
  }
  if (state.log.length !== lastLogLen) {
    lastLogLen = state.log.length;
  }
  if (done) return;
  // Revolution: decline.
  if (state.phase === "revolution" && state.legal.canRevolution) {
    send({ type: "act", action: { kind: "revolution", declare: false } });
    return;
  }
  // Illegal play #2: once, when we must follow, try a losing single first.
  if (state.phase === "playing" && state.turnSeat === youSeat && state.currentPlay) {
    const key = `${state.round}:${state.log.length}`;
    if (illegalSent === 1 && actedThisTurn !== state.log.length) {
      actedThisTurn = state.log.length;
      const loser = state.hand.find((c) => c.rank === "3" || c.rank === "4");
      if (loser) {
        illegalSent++;
        send({ type: "act", action: { kind: "play", cardIds: [loser.id] } });
        log("sent deliberate losing play (expect rejection)");
        // Keep playing: the server answers a rejection with a fresh state,
        // but send the real move right away too so a missed state can't stall us.
        const real = pickMove();
        if (real) {
          if (real.kind === "play") send({ type: "act", action: { kind: "play", cardIds: real.cardIds } });
          else if (real.kind === "let") send({ type: "act", action: { kind: "let" } });
          else send({ type: "act", action: { kind: "pass" } });
        }
        return;
      }
    }
  }
  const move = pickMove();
  if (move) {
    if (move.kind === "play") send({ type: "act", action: { kind: "play", cardIds: move.cardIds } });
    else if (move.kind === "let") send({ type: "act", action: { kind: "let" } });
    else send({ type: "act", action: { kind: "pass" } });
  }
};

ws.onerror = (e) => {
  log("ws error", e);
};

setTimeout(() => {
  log("TIMEOUT after 240s; phase:", state?.phase, "round:", state?.round, "illegalRejected:", illegalRejected);
  process.exit(3);
}, 240_000);
