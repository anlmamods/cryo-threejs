import { describe, it, expect } from "vitest";
import { perfTier, perfTierWithWarn, sample, stats, resetSpikes, checkSpike, spikes, mark, systemMs } from "../src/core/perf.js";

describe("perfTier", () => {
 it("thresholds", () => {
  expect(perfTier(100)).toBe("good");
  expect(perfTier(88)).toBe("good");
  expect(perfTier(87)).toBe("warn");
  expect(perfTier(60)).toBe("warn");
  expect(perfTier(59)).toBe("bad");
 });
});

describe("perfTierWithWarn", () => {
 it("custom warn bar", () => {
  expect(perfTierWithWarn(90, 75)).toBe("good");
  expect(perfTierWithWarn(70, 75)).toBe("warn");
  expect(perfTierWithWarn(50, 75)).toBe("bad");
 });
});

describe("sample/recompute", () => {
 it("median/fps computed", () => {
  // reset by sampling many identical values (can't reset internal ring easily; just sample)
  for (let i = 0; i < 5; i++) sample(16.7);
  // recompute throttled at 250ms; 5*16.7=83.5 < 250, may not recompute. Sample more.
  for (let i = 0; i < 20; i++) sample(16.7);
  expect(stats.median).toBeCloseTo(16.7, 1);
  expect(stats.fps).toBeCloseTo(1000 / 16.7, 1);
 });
});

describe("spikes", () => {
 it("count frames over median+4", () => {
  resetSpikes();
  // establish median
  for (let i = 0; i < 30; i++) sample(10);
  checkSpike(100);
  expect(spikes.count).toBe(1);
  expect(spikes.sinceReset).toBe(1);
 });
});

describe("mark/systemMs", () => {
 it("records per-system ms under each name", () => {
  mark("test cpu alpha", 1.5);
  mark("test cpu beta", 2.5);
  expect(systemMs["test cpu alpha"]).toBe(1.5);
  expect(systemMs["test cpu beta"]).toBe(2.5);
  delete systemMs["test cpu alpha"];
  delete systemMs["test cpu beta"];
 });
 it("re-marking a name overwrites (call once per frame per system); sums add across names", () => {
  mark("test cpu total", 4);
  mark("test cpu total", 6);
  mark("test cpu other", 1);
  expect(systemMs["test cpu total"]).toBe(6);
  expect(systemMs["test cpu other"]).toBe(1);
  expect(systemMs["test cpu total"] + systemMs["test cpu other"]).toBe(7);
  delete systemMs["test cpu total"];
  delete systemMs["test cpu other"];
 });
});
