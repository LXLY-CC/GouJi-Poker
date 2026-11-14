import "./style.css";
import { getSDK } from "@discourse-mini-app/sdk";
import { createHost } from "./host.ts";
import {
  RANK_LABEL,
  RANK_NAMES,
  checkGouji,
  federationScore,
  isSectionId,
  seatRelation,
} from "./logic.ts";
import type { RankId, RankName, SectionId } from "./logic.ts";
import messages from "./strings.json";

type TemplateElements = {
  connection: HTMLElement;
  player: HTMLElement;
  refresh: HTMLButtonElement;
  notice: HTMLElement;
  seatmap: HTMLElement;
  "seat-explain": HTMLElement;
  "checker-rank": HTMLSelectElement;
  "checker-count": HTMLElement;
  "checker-minus": HTMLButtonElement;
  "checker-plus": HTMLButtonElement;
  "checker-wang": HTMLInputElement;
  "checker-result": HTMLElement;
  "calc-a": HTMLSelectElement;
  "calc-b": HTMLSelectElement;
  "calc-c": HTMLSelectElement;
  "score-result": HTMLElement;
};

// IDs and data attributes come from the bundled template.
const element = <Id extends string>(id: Id) =>
  document.getElementById(id) as Id extends keyof TemplateElements
    ? TemplateElements[Id]
    : HTMLElement;

const STATE_KEY = "gouji-guide-state";
const host = createHost(import.meta.env.DEV ? null : getSDK(), messages, {
  onIdentity(user) {
    element("player").textContent = user
      ? t("player", { ...user, name: user.name || user.username })
      : t("guestName");
  },
  onMode(mode) {
    element("connection").textContent = t(mode);
  },
  onNotice(text) {
    element("notice").textContent = text;
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
    document.documentElement.dataset.reducedMotion = String(
      theme.reducedMotion
    );
    localize();
  },
});
const t = host.t;

let ready = false;
let section: SectionId = "overview";
let seat: number | null = null;
let checkerCount = 2;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function localize() {
  document.querySelectorAll<HTMLElement>("[data-text]").forEach((node) => {
    node.textContent = t(node.dataset.text!);
  });
}

function stateSnapshot() {
  return {
    format: 1,
    section,
    seat,
    checker: {
      rank: element("checker-rank").value as RankId,
      count: checkerCount,
      withWang: element("checker-wang").checked,
    },
    calculator: [
      element("calc-a").value,
      element("calc-b").value,
      element("calc-c").value,
    ] as RankName[],
  };
}

function persist() {
  if (!ready) {
    return;
  }
  clearTimeout(saveTimer ?? undefined);
  saveTimer = null;
  void host.save(STATE_KEY, stateSnapshot());
}

function schedulePersist() {
  if (!ready || saveTimer) {
    return;
  }
  saveTimer = setTimeout(persist, 2000);
}

function renderSeat() {
  const buttons = Array.from(
    element("seatmap").querySelectorAll<HTMLButtonElement>("[data-seat]")
  );
  const relation = seat === null ? null : seatRelation(seat);
  buttons.forEach((button) => {
    const number = Number(button.dataset.seat);
    button.classList.toggle("is-selected", number === seat);
    button.classList.toggle(
      "is-opponent",
      relation !== null && number === relation.opposite
    );
    button.classList.toggle(
      "is-mate",
      relation !== null && relation.teammates.includes(number)
    );
  });
  const explain = element("seat-explain");
  if (relation === null) {
    explain.textContent = t("seatDefault");
    return;
  }
  explain.textContent = [
    t("seatYou", { seat: relation.seat }),
    t("seatTeammates", { teammates: relation.teammates.join("、") }),
    t("seatOpponent", { opponent: relation.opposite }),
  ].join(" ");
}

function renderChecker() {
  const rank = element("checker-rank").value as RankId;
  const withWang = element("checker-wang").checked;
  element("checker-count").textContent = String(checkerCount);
  const result = element("checker-result");
  const check = checkGouji(rank, checkerCount, withWang);
  const parts = [t(check.isGouji ? "checkerResultYes" : "checkerResultNo")];
  if (withWang) {
    parts.push(t("checkerWithWang"));
  } else if (check.threshold === null) {
    parts.push(t("checkerNoThreshold", { rank: RANK_LABEL[rank] }));
  } else if (check.isGouji) {
    parts.push(
      t("checkerMet", {
        rank: RANK_LABEL[rank],
        threshold: check.threshold,
        count: checkerCount,
      })
    );
  } else {
    parts.push(
      t("checkerNeedMore", {
        n: check.missing,
        rank: RANK_LABEL[rank],
        threshold: check.threshold,
      })
    );
  }
  result.textContent = parts.join(" ");
  result.classList.toggle("is-good", check.isGouji);
}

function renderScore() {
  const ranks = [
    element("calc-a").value,
    element("calc-b").value,
    element("calc-c").value,
  ] as RankName[];
  const result = element("score-result");
  const score = federationScore(ranks);
  if (!score.valid) {
    result.textContent = t("scoreDuplicate");
    result.classList.remove("is-good");
    return;
  }
  const parts = [
    t("scoreTotal", { total: score.total }),
    t("scoreBreakdown", {
      ranks: ranks.join("、"),
      raw: score.raw,
    }),
  ];
  if (score.doubled) {
    parts.push(t("scoreDoubled"));
  }
  if (score.raw < 0) {
    parts.push(t("scoreFloored"));
  }
  result.textContent = parts.join(" ");
  result.classList.toggle("is-good", score.total > 0);
}

function renderTools() {
  renderSeat();
  renderChecker();
  renderScore();
}

function restoreState(value: unknown) {
  if (!value || typeof value !== "object") {
    return;
  }
  const saved = value as {
    format?: unknown;
    section?: unknown;
    seat?: unknown;
    checker?: { rank?: unknown; count?: unknown; withWang?: unknown };
    calculator?: unknown;
  };
  if (saved.format !== 1) {
    return;
  }
  if (isSectionId(saved.section)) {
    section = saved.section;
  }
  if (
    Number.isInteger(saved.seat) &&
    (saved.seat as number) >= 1 &&
    (saved.seat as number) <= 6
  ) {
    seat = saved.seat as number;
  }
  if (saved.checker) {
    const rank = saved.checker.rank;
    if (typeof rank === "string") {
      element("checker-rank").value = rank;
    }
    if (
      Number.isSafeInteger(saved.checker.count) &&
      (saved.checker.count as number) >= 1 &&
      (saved.checker.count as number) <= 24
    ) {
      checkerCount = saved.checker.count as number;
    }
    element("checker-wang").checked = saved.checker.withWang === true;
  }
  if (
    Array.isArray(saved.calculator) &&
    saved.calculator.length === 3 &&
    saved.calculator.every((name) =>
      (RANK_NAMES as readonly string[]).includes(String(name))
    )
  ) {
    element("calc-a").value = String(saved.calculator[0]);
    element("calc-b").value = String(saved.calculator[1]);
    element("calc-c").value = String(saved.calculator[2]);
  }
}

async function initialize() {
  await host.connect();
  const previous = await host.load(STATE_KEY);
  restoreState(previous);
  ready = true;
  renderTools();
  if (previous) {
    element("notice").textContent = t("restored");
  }
  const target = document.getElementById(section);
  if (section !== "overview" && target) {
    target.scrollIntoView({ block: "start" });
  }
  await host.rendered();
}

element("refresh").addEventListener("click", async () => {
  element("refresh").disabled = true;
  try {
    await host.connect();
  } finally {
    element("refresh").disabled = false;
  }
});

document.querySelectorAll<HTMLAnchorElement>(".guide__nav a").forEach((link) => {
  link.addEventListener("click", () => {
    const next = link.dataset.section;
    if (isSectionId(next)) {
      section = next;
      schedulePersist();
    }
  });
});

element("seatmap").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest?.(
    "[data-seat]"
  ) as HTMLButtonElement | null;
  if (!button) {
    return;
  }
  const number = Number(button.dataset.seat);
  seat = seat === number ? null : number;
  renderSeat();
  schedulePersist();
});

element("checker-rank").addEventListener("change", () => {
  renderChecker();
  schedulePersist();
});
element("checker-wang").addEventListener("change", () => {
  renderChecker();
  schedulePersist();
});
element("checker-minus").addEventListener("click", () => {
  checkerCount = Math.max(1, checkerCount - 1);
  renderChecker();
  schedulePersist();
});
element("checker-plus").addEventListener("click", () => {
  checkerCount = Math.min(24, checkerCount + 1);
  renderChecker();
  schedulePersist();
});

for (const id of ["calc-a", "calc-b", "calc-c"] as const) {
  element(id).addEventListener("change", () => {
    renderScore();
    schedulePersist();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && seat !== null) {
    seat = null;
    renderSeat();
    schedulePersist();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    persist();
  }
});
window.addEventListener("pagehide", () => {
  clearTimeout(saveTimer ?? undefined);
  persist();
  host.dispose();
});

localize();
renderTools();
void initialize();
