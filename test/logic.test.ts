import { describe, expect, test } from "bun:test";
import {
  checkGouji,
  federationScore,
  isSectionId,
  seatRelation,
} from "../src/logic.ts";

describe("够级牌判定", () => {
  test("口诀门槛：单钱单花、双 A 双 K、三 Q、四 J、五 10", () => {
    expect(checkGouji("2", 1, false).isGouji).toBe(true);
    expect(checkGouji("small-joker", 1, false).isGouji).toBe(true);
    expect(checkGouji("big-joker", 1, false).isGouji).toBe(true);
    expect(checkGouji("A", 2, false).isGouji).toBe(true);
    expect(checkGouji("K", 2, false).isGouji).toBe(true);
    expect(checkGouji("Q", 3, false).isGouji).toBe(true);
    expect(checkGouji("J", 4, false).isGouji).toBe(true);
    expect(checkGouji("10", 5, false).isGouji).toBe(true);
  });

  test("低于门槛不算够级，并报出还差几张", () => {
    const check = checkGouji("10", 2, false);
    expect(check.isGouji).toBe(false);
    expect(check.threshold).toBe(5);
    expect(check.missing).toBe(3);
    expect(checkGouji("J", 3, false).missing).toBe(1);
    expect(checkGouji("Q", 2, false).missing).toBe(1);
    expect(checkGouji("A", 1, false).missing).toBe(1);
  });

  test("超过门槛的同点牌也是够级牌", () => {
    expect(checkGouji("10", 6, false).isGouji).toBe(true);
    expect(checkGouji("K", 3, false).isGouji).toBe(true);
    expect(checkGouji("Q", 8, false).isGouji).toBe(true);
  });

  test("9 及以下张数再多也不够级，除非挂王", () => {
    for (const rank of ["3", "4", "5", "6", "7", "8", "9"] as const) {
      const check = checkGouji(rank, 12, false);
      expect(check.isGouji).toBe(false);
      expect(check.threshold).toBeNull();
    }
    expect(checkGouji("9", 12, true).isGouji).toBe(true);
    expect(checkGouji("3", 1, true).withWang).toBe(true);
  });

  test("挂王的任何一手牌都算够级牌", () => {
    expect(checkGouji("5", 1, true).isGouji).toBe(true);
    expect(checkGouji("10", 1, true).isGouji).toBe(true);
  });

  test("无效张数按 0 张处理", () => {
    expect(checkGouji("10", 0, false).isGouji).toBe(false);
    expect(checkGouji("10", 0, false).missing).toBe(5);
  });
});

describe("联邦计分", () => {
  test("头科 +2 科 + 三科 = 6 分，串三户翻倍 12 分", () => {
    const score = federationScore(["头科", "二科", "三科"]);
    expect(score.valid).toBe(true);
    expect(score.raw).toBe(6);
    expect(score.doubled).toBe(true);
    expect(score.total).toBe(12);
  });

  test("串三户只认头、二、三科三人齐聚，顺序不限", () => {
    expect(federationScore(["三科", "头科", "二科"]).total).toBe(12);
    expect(federationScore(["头科", "二科", "四科"]).total).toBe(6);
    expect(federationScore(["头科", "二科", "四科"]).doubled).toBe(false);
  });

  test("普通名次按头科 4、二科 2、三四科 0、二落 -2、大落 -4 相加", () => {
    expect(federationScore(["头科", "四科", "大落"]).total).toBe(0);
    expect(federationScore(["二科", "三科", "二落"]).total).toBe(0);
    expect(federationScore(["头科", "二科", "二落"]).total).toBe(4);
  });

  test("合计为负按规则记 0 分", () => {
    const score = federationScore(["三科", "二落", "大落"]);
    expect(score.raw).toBe(-6);
    expect(score.total).toBe(0);
  });

  test("三人名次重复或不足三人无效", () => {
    expect(federationScore(["头科", "头科", "二科"]).valid).toBe(false);
    expect(federationScore(["头科", "二科"]).valid).toBe(false);
    expect(federationScore([]).valid).toBe(false);
  });
});

describe("座位关系", () => {
  test("对头是正对面的人，队友是间隔落座的两人", () => {
    expect(seatRelation(1)).toEqual({
      seat: 1,
      opposite: 4,
      teammates: [3, 5],
    });
    expect(seatRelation(3)).toEqual({
      seat: 3,
      opposite: 6,
      teammates: [5, 1],
    });
    expect(seatRelation(6)).toEqual({
      seat: 6,
      opposite: 3,
      teammates: [2, 4],
    });
  });

  test("两个联邦各是 1、3、5 与 2、4、6", () => {
    const fedA = [1, 3, 5].map((seat) => seatRelation(seat)!);
    for (const relation of fedA) {
      expect(relation.teammates.every((mate) => [1, 3, 5].includes(mate))).toBe(
        true
      );
      expect([2, 4, 6]).toContain(relation.opposite);
    }
  });

  test("座位号越界返回 null", () => {
    expect(seatRelation(0)).toBeNull();
    expect(seatRelation(7)).toBeNull();
  });
});

describe("章节 ID", () => {
  test("只接受指南里真实存在的章节", () => {
    expect(isSectionId("six-decks")).toBe(true);
    expect(isSectionId("overview")).toBe(true);
    expect(isSectionId("nope")).toBe(false);
    expect(isSectionId(null)).toBe(false);
  });
});
