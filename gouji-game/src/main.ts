import "./style.css";
import { getSDK } from "@discourse-mini-app/sdk";
import { createHost } from "./host.ts";
import { createLocalDriver } from "./local.ts";
import type { TableDriver } from "./local.ts";
import { createNetClient } from "./net.ts";
import { SERVER_CONFIGURED } from "./config.ts";
import { beats, parsePlay, rankIndex } from "./engine/play.ts";
import { federationOf } from "./engine/types.ts";
import type { Card } from "./engine/types.ts";
import type { ClientState, RoomOptions } from "./engine/protocol.ts";
import { roomCode } from "./engine/protocol.ts";
import messages from "./strings.json";

type TemplateElements = {
  connection: HTMLElement;
  player: HTMLElement;
  notice: HTMLElement;
  lobby: HTMLElement;
  table: HTMLElement;
  rules: HTMLElement;
  "mode-ai": HTMLButtonElement;
  "mode-online": HTMLButtonElement;
  "server-warning": HTMLElement;
  "online-fields": HTMLElement;
  "room-code": HTMLInputElement;
  "player-name": HTMLInputElement;
  "create-room": HTMLButtonElement;
  "join-room": HTMLButtonElement;
  "deck-option": HTMLSelectElement;
  "eagle-field": HTMLElement;
  "eagle-mode": HTMLSelectElement;
  "start-ai": HTMLButtonElement;
  "ready-btn": HTMLButtonElement;
  "lobby-seats": HTMLElement;
  scoreboard: HTMLElement;
  "rules-toggle": HTMLButtonElement;
  "rules-close": HTMLButtonElement;
  "leave-btn": HTMLButtonElement;
  seats: HTMLElement;
  "last-play": HTMLElement;
  "turn-line": HTMLElement;
  "round-line": HTMLElement;
  hand: HTMLElement;
  "play-btn": HTMLButtonElement;
  "pass-btn": HTMLButtonElement;
  "burn-btn": HTMLButtonElement;
  "let-btn": HTMLButtonElement;
  "revolution-btn": HTMLButtonElement;
  "hint-btn": HTMLButtonElement;
  "sort-btn": HTMLButtonElement;
  "next-round-btn": HTMLButtonElement;
  "end-match-btn": HTMLButtonElement;
  "game-log": HTMLElement;
};

const element = <Id extends string>(id: Id) =>
  document.getElementById(id) as Id extends keyof TemplateElements
    ? TemplateElements[Id]
    : HTMLElement;

const host = createHost(import.meta.env.DEV ? null : getSDK(), messages, {
  onIdentity(user) {
    element("player").textContent = user
      ? host.t("player", { ...user, name: user.name || user.username })
      : host.t("guestName");
    if (user && !element("player-name").value) {
      element("player-name").value = user.name || user.username;
    }
  },
  onMode(mode) {
    element("connection").textContent = host.t(mode);
  },
  onNotice(text) {
    showNotice(text);
  },
  onTheme(theme) {
    const style = document.documentElement.style;
    for (const [property, value] of Object.entries({
      primary: theme.text,
      secondary: theme.background,
      accent: theme.accent,
      line: theme.border,
    })) {
      style.setProperty(`--${property}`, value);
    }
    style.colorScheme = theme.mode;
    document.documentElement.dataset.reducedMotion = String(theme.reducedMotion);
    localize();
  },
});
const t = host.t;

let mode: "ai" | "online" = "ai";
let driver: TableDriver | null = null;
let netClient: ReturnType<typeof createNetClient> | null = null;
let state: ClientState | null = null;
let selected = new Set<string>();
let sortBySuit = false;
let myName = "牌友";

function localize() {
  document.querySelectorAll<HTMLElement>("[data-text]").forEach((node) => {
    node.textContent = t(node.dataset.text!);
  });
}

function showNotice(text: string) {
  element("notice").textContent = text;
}

const RANK_LABEL: Record<string, string> = {
  "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10",
  J: "J", Q: "Q", K: "K", A: "A", "2": "2",
  "small-joker": "小王", "big-joker": "大王", eagle: "鹰",
};
const SUIT_SYMBOL: Record<string, string> = {
  spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦",
};

function cardLabel(card: Card): { rank: string; suit: string; red: boolean } {
  const rank = RANK_LABEL[card.rank] ?? card.rank;
  const suit = SUIT_SYMBOL[card.suit] ?? "★";
  const red = card.suit === "hearts" || card.suit === "diamonds";
  return { rank, suit, red };
}

function makeCardEl(card: Card, mini: boolean): HTMLElement {
  const { rank, suit, red } = cardLabel(card);
  const el = document.createElement("span");
  el.className = `card${mini ? " mini" : ""}${red ? " red" : ""}${
    card.rank === "small-joker" || card.rank === "big-joker" ? " joker" : ""
  }${card.rank === "eagle" ? " eagle" : ""}`;
  const rankEl = document.createElement("span");
  rankEl.className = "rank";
  rankEl.textContent = rank;
  const suitEl = document.createElement("span");
  suitEl.className = "suit";
  suitEl.textContent = suit;
  el.append(rankEl, suitEl);
  return el;
}

function roomOptions(): RoomOptions {
  return {
    decks: element("deck-option").value === "sixEagle" ? "sixEagle" : "classic4",
    eagleMode: element("eagle-mode").value as RoomOptions["eagleMode"],
    bots: true,
  };
}

function setMode(next: "ai" | "online") {
  mode = next;
  element("mode-ai").setAttribute("aria-pressed", String(mode === "ai"));
  element("mode-online").setAttribute("aria-pressed", String(mode === "online"));
  element("online-fields").hidden = mode !== "online";
  element("start-ai").hidden = mode !== "ai";
  element("ready-btn").hidden = mode !== "online";
  element("server-warning").hidden = mode !== "online" || SERVER_CONFIGURED;
  if (mode === "online" && !SERVER_CONFIGURED) {
    element("create-room").disabled = true;
    element("join-room").disabled = true;
  } else {
    element("create-room").disabled = false;
    element("join-room").disabled = false;
  }
}

function showLobby() {
  element("lobby").hidden = false;
  element("table").hidden = true;
  element("rules").hidden = true;
}

function showTable() {
  element("lobby").hidden = true;
  element("table").hidden = false;
}

function seatName(seat: number): string {
  const s = state?.seats.find((p) => p.seat === seat);
  return s?.name || `${seat} 号位`;
}

function renderSeats() {
  if (!state) return;
  const wrap = element("seats");
  wrap.innerHTML = "";
  const you = state.youSeat;
  for (const p of state.seats) {
    const div = document.createElement("div");
    div.className = `seat${state.turnSeat === p.seat ? " turn" : ""}${p.seat === you ? " me" : ""}`;
    const name = document.createElement("div");
    name.className = "seat-name";
    const fed = you !== null ? (federationOf(p.seat) === federationOf(you) ? " · 同队" : " · 对家") : "";
    const opposite = you !== null && ((you + 2) % 6) + 1 === p.seat ? " · 对头" : "";
    name.textContent = `${p.seat} 号 ${p.name || "空位"}${p.isBot ? "（机器人）" : ""}${fed}${opposite}`;
    const meta = document.createElement("div");
    meta.className = "seat-meta";
    const badges: string[] = [];
    if (p.finishedRank) badges.push(p.finishedRank);
    else if (p.revolution) badges.push("革命");
    else if (p.opened) badges.push("已开点");
    else badges.push("未开点");
    if (p.pendingOpen) badges.push("待开点");
    if (p.handCount === 0 && !p.finishedRank) badges.push("出完");
    meta.textContent = `${p.handCount} 张 · ${badges.join(" · ")}`;
    div.append(name, meta);
    wrap.append(div);
  }
  // Lobby seat strip (online waiting room).
  const strip = element("lobby-seats");
  strip.innerHTML = "";
  for (const p of state.seats) {
    const chip = document.createElement("span");
    chip.className = `seat-chip${p.name ? "" : " empty"}${p.seat === you ? " me" : ""}`;
    chip.textContent = p.name
      ? `${p.seat} 号 ${p.name}${p.ready ? " ✓" : ""}`
      : `${p.seat} 号 空位`;
    strip.append(chip);
  }
}

function renderCenter() {
  if (!state) return;
  const last = element("last-play");
  last.innerHTML = "";
  if (state.currentPlay) {
    const who = document.createElement("span");
    who.textContent = `${seatName(state.currentPlay.seat)} 出：`;
    last.append(who);
    for (const card of state.currentPlay.cards) {
      last.append(makeCardEl(card, true));
    }
    if (state.currentPlay.isGouji) {
      const tag = document.createElement("span");
      tag.textContent = "（够级牌）";
      last.append(tag);
    }
  } else if (state.phase === "playing") {
    last.textContent = "新一轮，由你方先出。";
  } else {
    last.textContent = "等待开局…";
  }
  const turn = element("turn-line");
  if (state.phase === "lobby") turn.textContent = "等待玩家加入并准备…";
  else if (state.phase === "revolution") turn.textContent = "革命选择中：没有 2 / 王的玩家可选择革命。";
  else if (state.phase === "playing" && state.turnSeat !== null) {
    turn.textContent =
      state.turnSeat === state.youSeat ? "轮到你出牌" : `轮到 ${seatName(state.turnSeat)} 出牌`;
  } else if (state.phase === "round-end") {
    const r = state.roundScores;
    turn.textContent = r
      ? `本局结束：${Object.entries(r.ranks)
          .map(([seat, rank]) => `${seatName(Number(seat))}${rank}`)
          .join("、")}；联邦 A ${r.fedA} : ${r.fedB} 联邦 B${r.doubled ? "（串三户翻倍）" : ""}`
      : "本局结束";
  }
  element("round-line").textContent =
    `第 ${state.round} 局 · 联邦累计 A ${state.scores.A} : ${state.scores.B} B` +
    (state.tributes.length > 0
      ? ` · 进贡：${state.tributes.map((tr) => `${seatName(tr.from)}→${seatName(tr.to)}（${tr.kind}）`).join("、")}`
      : "");
}

function sortHand(hand: Card[]): Card[] {
  const suitOrder = ["spades", "hearts", "clubs", "diamonds", "joker"];
  return [...hand].sort((a, b) => {
    const d = rankIndex(a.rank) - rankIndex(b.rank);
    if (d !== 0) return d;
    if (sortBySuit) return suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
    return a.id.localeCompare(b.id);
  });
}

function renderHand() {
  if (!state) return;
  const wrap = element("hand");
  wrap.innerHTML = "";
  for (const card of sortHand(state.hand)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `card${selected.has(card.id) ? " selected" : ""}`;
    const { rank, suit, red } = cardLabel(card);
    if (red) btn.classList.add("red");
    if (card.rank === "small-joker" || card.rank === "big-joker") btn.classList.add("joker");
    if (card.rank === "eagle") btn.classList.add("eagle");
    const rankEl = document.createElement("span");
    rankEl.className = "rank";
    rankEl.textContent = rank;
    const suitEl = document.createElement("span");
    suitEl.className = "suit";
    suitEl.textContent = suit;
    btn.append(rankEl, suitEl);
    btn.addEventListener("click", () => {
      if (selected.has(card.id)) selected.delete(card.id);
      else selected.add(card.id);
      renderHand();
    });
    wrap.append(btn);
  }
  if (state.hand.length === 0) {
    wrap.textContent = state.phase === "playing" ? "你已出完手牌。" : "等待发牌…";
  }
}

function renderActions() {
  if (!state) return;
  const legal = state.legal;
  const inGame = state.phase === "playing" || state.phase === "revolution";
  element("play-btn").disabled = !inGame || !legal.canPlay;
  element("pass-btn").disabled = !inGame || !legal.canPass;
  element("burn-btn").disabled = !inGame || !legal.canBurn;
  element("let-btn").disabled = !inGame || !legal.canLet;
  element("revolution-btn").disabled = state.phase !== "revolution" || !legal.canRevolution;
  element("hint-btn").disabled = !inGame;
  element("next-round-btn").hidden = state.phase !== "round-end";
  element("end-match-btn").hidden = state.phase === "lobby";
}

function renderScoreboard() {
  if (!state) return;
  element("scoreboard").innerHTML = "";
  const a = document.createElement("span");
  a.textContent = `联邦 A（1·3·5 号）${state.scores.A} 分`;
  const b = document.createElement("span");
  b.textContent = `联邦 B（2·4·6 号）${state.scores.B} 分`;
  element("scoreboard").append(a, b);
}

function renderLog() {
  if (!state) return;
  const log = element("game-log");
  log.innerHTML = "";
  for (const line of state.log.slice(-30)) {
    const p = document.createElement("p");
    p.textContent = line;
    log.append(p);
  }
  log.scrollTop = log.scrollHeight;
}

function render(next: ClientState) {
  const phaseChanged = state?.phase !== next.phase;
  state = next;
  if (phaseChanged) selected.clear();
  // Keep selection valid after a state update.
  const ids = new Set(next.hand.map((c) => c.id));
  for (const id of [...selected]) {
    if (!ids.has(id)) selected.delete(id);
  }
  if (next.phase === "lobby" && mode === "online") {
    showLobby();
  } else {
    showTable();
  }
  element("ready-btn").hidden = mode !== "online" || next.phase !== "lobby";
  renderSeats();
  renderCenter();
  renderHand();
  renderActions();
  renderScoreboard();
  renderLog();
}

function selectedCards(): Card[] {
  if (!state) return [];
  const byId = new Map(state.hand.map((c) => [c.id, c]));
  return [...selected].map((id) => byId.get(id)!).filter(Boolean);
}

function currentPlayInfo() {
  if (!state?.currentPlay) return null;
  return parsePlay(state.currentPlay.cards);
}

function doPlay() {
  if (!state || !driver) return;
  const cards = selectedCards();
  if (cards.length === 0) {
    showNotice("请先选牌。");
    return;
  }
  const play = parsePlay(cards);
  if (!play) {
    showNotice("这手牌不合法：同点数 N 张，可挂 2 / 王；3、4 不能挂牌。");
    return;
  }
  const current = currentPlayInfo();
  if (current && !beats(play, current)) {
    showNotice("压不过上家的牌。");
    return;
  }
  selected.clear();
  driver.act({ kind: "play", cardIds: cards.map((c) => c.id) });
}

function doBurn() {
  if (!state || !driver) return;
  const cards = selectedCards();
  if (cards.length === 0) {
    showNotice("请选择要烧的够级牌。");
    return;
  }
  const play = parsePlay(cards);
  const current = currentPlayInfo();
  if (!play || !play.isGouji) {
    showNotice("烧牌必须是一手够级牌。");
    return;
  }
  if (!current || !beats(play, current)) {
    showNotice("烧牌必须压过上家的够级牌。");
    return;
  }
  selected.clear();
  driver.act({ kind: "burn", cardIds: cards.map((c) => c.id) });
}

function wireActions() {
  element("play-btn").addEventListener("click", doPlay);
  element("pass-btn").addEventListener("click", () => driver?.act({ kind: "pass" }));
  element("burn-btn").addEventListener("click", doBurn);
  element("let-btn").addEventListener("click", () => driver?.act({ kind: "let" }));
  element("revolution-btn").addEventListener("click", () =>
    driver?.act({ kind: "revolution", declare: true })
  );
  element("hint-btn").addEventListener("click", () => {
    if (!state) return;
    const hint = state.legal.hintCardIds;
    if (hint && hint.length > 0) {
      selected = new Set(hint);
      renderHand();
    } else {
      showNotice("当前没有可出的牌，点“不要”。");
    }
  });
  element("sort-btn").addEventListener("click", () => {
    sortBySuit = !sortBySuit;
    renderHand();
  });
  element("next-round-btn").addEventListener("click", () => driver?.nextRound());
  element("end-match-btn").addEventListener("click", () => {
    driver?.endMatch();
    driver = null;
    state = null;
    selected.clear();
    showLobby();
  });
  element("leave-btn").addEventListener("click", () => {
    driver?.leave();
    driver = null;
    state = null;
    selected.clear();
    showLobby();
    showNotice("已离开牌桌。");
  });
  element("rules-toggle").addEventListener("click", () => {
    element("rules").hidden = !element("rules").hidden;
  });
  element("rules-close").addEventListener("click", () => {
    element("rules").hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !element("play-btn").disabled) {
      event.preventDefault();
      doPlay();
    } else if (event.key === "Escape") {
      selected.clear();
      renderHand();
    }
  });
}

function wireLobby() {
  element("mode-ai").addEventListener("click", () => setMode("ai"));
  element("mode-online").addEventListener("click", () => setMode("online"));
  element("deck-option").addEventListener("change", () => {
    element("eagle-field").hidden = element("deck-option").value !== "sixEagle";
  });
  element("start-ai").addEventListener("click", () => {
    myName = element("player-name").value.trim() || "你";
    driver = createLocalDriver({
      onState: render,
      onNotice: showNotice,
    });
    driver.start(roomOptions());
    showTable();
  });
  element("create-room").addEventListener("click", () => void joinOnline(roomCode()));
  element("join-room").addEventListener("click", () => {
    const code = element("room-code").value.trim().toUpperCase();
    if (!code) {
      showNotice("请填写房间代码。");
      return;
    }
    void joinOnline(code);
  });
  element("ready-btn").addEventListener("click", () => driver?.ready());
}

async function joinOnline(code: string) {
  if (!SERVER_CONFIGURED) {
    showNotice("在线服务器尚未配置，请先部署服务器并替换 WSS 地址。");
    return;
  }
  myName = element("player-name").value.trim() || "牌友";
  element("room-code").value = code;
  netClient = createNetClient({
    onState: render,
    onNotice: showNotice,
    onError: showNotice,
  });
  driver = netClient;
  showNotice(`正在连接房间 ${code}…`);
  await netClient.connect(code, myName, roomOptions());
}

async function main() {
  localize();
  setMode("ai");
  wireActions();
  wireLobby();
  await host.connect();
  await host.rendered();
}

void main();
