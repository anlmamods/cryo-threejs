import { describe, it, expect, afterEach, vi } from "vitest";
import { assetCandidates, fetchAsset } from "../src/core/assets.js";

afterEach(() => {
 vi.unstubAllGlobals();
 vi.unstubAllEnvs();
 vi.resetModules();
});
describe("assets", () => {
 it("no base -> single candidate", () => {
  const c = assetCandidates("audio/x.mp3");
  expect(c).toEqual(["audio/x.mp3"]);
 });
 it("strips leading slash", () => {
  const c = assetCandidates("/audio/x.mp3");
  expect(c[0]).toBe("audio/x.mp3");
 });
});

describe("fetchAsset", () => {
 it("returns the ok response when the only candidate succeeds", async () => {
  const res = { ok: true, status: 200 } as unknown as Response;
  const fetchMock = vi.fn(async () => res);
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchAsset("audio/x.mp3")).resolves.toBe(res);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("audio/x.mp3");
 });
 it("throws with the HTTP status when the only candidate fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
  await expect(fetchAsset("audio/x.mp3")).rejects.toThrow(/404/);
 });
 it("falls back to the origin copy when the CDN primary answers 503", async () => {
  vi.stubEnv("VITE_ASSET_BASE", "https://cdn.example.test");
  vi.resetModules();
  // ASSET_BASE is fixed at module-eval from import.meta.env, so the CDN-base case needs a fresh module instance — a static import cannot work here.
  const mod = await import("../src/core/assets.js");
  const okRes = { ok: true, status: 200 } as unknown as Response;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
   const url = String(input);
   return url.startsWith("https://cdn.example.test/")
    ? ({ ok: false, status: 503 } as unknown as Response)
    : okRes;
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(mod.fetchAsset("audio/x.mp3")).resolves.toBe(okRes);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[0][0])).toBe("https://cdn.example.test/audio/x.mp3");
  expect(String(fetchMock.mock.calls[1][0])).toBe("audio/x.mp3");
 });
 it("throws the last error when every candidate fails", async () => {
  vi.stubEnv("VITE_ASSET_BASE", "https://cdn.example.test");
  vi.resetModules();
  // fresh module instance for the stubbed VITE_ASSET_BASE (see above)
  const mod = await import("../src/core/assets.js");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
  await expect(mod.fetchAsset("audio/x.mp3")).rejects.toThrow(/503/);
  // the error names the last (fallback) URL tried
  await expect(mod.fetchAsset("audio/x.mp3")).rejects.toThrow(/audio\/x\.mp3/);
 });
 it("throws the fetch error itself when every candidate rejects", async () => {
  vi.stubEnv("VITE_ASSET_BASE", "https://cdn.example.test");
  vi.resetModules();
  // fresh module instance for the stubbed VITE_ASSET_BASE (see above)
  const mod = await import("../src/core/assets.js");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
  await expect(mod.fetchAsset("audio/x.mp3")).rejects.toThrow("connection reset");
 });
});
