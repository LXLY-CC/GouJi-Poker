/**
 * Local vs-AI driver: the same authoritative Game engine and bot AI run
 * entirely in the client, so the game is playable with no server at all.
 * The human sits at seat 1; five bots fill the other seats.
 */
import { Game } from "./engine/game.ts";
import type { PlayerAction } from "./engine/game.ts";
import { botAction } from "./engine/ai.ts";
import type { ClientState, RoomOptions } from "./engine/protocol.ts";

const BOT_NAMES = ["阿强", "阿珍", "阿明", "阿华", "阿丽"];
const BOT_STEP_MS = 750;

export interface TableDriver {
  onState: (state: ClientState) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  start(options: RoomOptions): void;
  act(action: PlayerAction): void;
  ready(): void;
  nextRound(): void;
  endMatch(): void;
  leave(): void;
}

export function createLocalDriver(callbacks: {
  onState: (state: ClientState) => void;
  onNotice: (text: string) => void;
}): TableDriver {
  let game: Game | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const humanSeat = 1;

  const emit = () => {
    if (game) callbacks.onState({ ...game.snapshotFor(humanSeat), youSeat: humanSeat, youUserId: "local:you" });
  };

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const stepBots = (): boolean => {
    if (!game) return false;
    // Revolution has a 15 s deadline; advance it even when the human is silent.
    if (game.tick(Date.now())) return true;
    if (game.phase === "revolution") {
      let acted = false;
      for (const seat of game.revolutionEligible) {
        if (seat === humanSeat || !game.player(seat).isBot) continue;
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
    for (let seat = 1; seat <= 6; seat++) {
      if (seat === humanSeat || !game.player(seat).isBot) continue;
      if (game.legalActions(seat).canBurn) {
        const action = botAction(game, seat);
        if (action && action.kind === "burn") {
          const r = game.act(seat, action);
          if (r.ok) return true;
        }
      }
    }
    const turn = game.turnSeat;
    if (turn === null || turn === humanSeat || !game.player(turn).isBot) return false;
    const action = botAction(game, turn);
    if (!action) return false;
    const result = game.act(turn, action);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn("[够级] bot action rejected", action, result.error);
      return false;
    }
    return true;
  };

  const schedule = () => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (stepBots()) {
        emit();
        schedule();
      }
    }, BOT_STEP_MS);
  };

  return {
    onState: callbacks.onState,
    onNotice: callbacks.onNotice,
    onError: (text) => callbacks.onNotice(text),
    start(options) {
      clearTimer();
      game = new Game("LOCAL", options);
      game.addPlayer(humanSeat, "你", false, "local:you");
      BOT_NAMES.forEach((name, i) => game!.addPlayer(i + 2, name, true, `local:bot-${i + 2}`));
      for (let seat = 1; seat <= 6; seat++) game.setReady(seat);
      callbacks.onNotice("人机对战开始：你坐 1 号位，对面是五位机器人牌友。");
      emit();
      schedule();
    },
    act(action) {
      if (!game) return;
      const result = game.act(humanSeat, action);
      if (!result.ok) {
        callbacks.onNotice(result.error ?? "操作被拒绝");
        return;
      }
      emit();
      schedule();
    },
    ready() {
      // Local games start immediately; nothing to do.
    },
    nextRound() {
      if (!game) return;
      const result = game.act(humanSeat, { kind: "next-round" });
      if (!result.ok) {
        callbacks.onNotice(result.error ?? "操作被拒绝");
        return;
      }
      emit();
      schedule();
    },
    endMatch() {
      clearTimer();
      game = null;
    },
    leave() {
      clearTimer();
      game = null;
    },
  };
}
