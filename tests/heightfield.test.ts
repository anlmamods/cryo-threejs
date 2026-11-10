import { describe, it, expect, vi, afterEach } from "vitest";
import * as THREE from "three";
import { Heightfield } from "../src/terrain/heightfield.js";
import type { Gfx } from "../src/core/gfx.js";

/** Structural stand-in for the slice of Gfx the heightfield touches. */
interface StubGfx {
  caps: { floatLinear: boolean };
  makeRenderTarget: (
    name: string, w: number, h: number, opts?: unknown,
  ) => { texture: THREE.Texture; dispose(): void };
  renderer: {
    setRenderTarget(target: unknown): void;
    render(scene: unknown, camera: unknown): void;
    readRenderTargetPixels(
      target: unknown, x: number, y: number, w: number, h: number, buf: Float32Array,
    ): void;
  };
}

/** Minimal gfx stub: the ctor only needs caps + makeRenderTarget; _readback
 *  additionally touches renderer.setRenderTarget/render/readRenderTargetPixels. */
function makeGfx(overrides: Partial<StubGfx> = {}): StubGfx {
  const base: StubGfx = {
    caps: { floatLinear: true },
    makeRenderTarget: (_name: string, _w: number, _h: number, _opts?: unknown) => ({
      texture: new THREE.Texture(),
      dispose() { },
    }),
    renderer: {
      setRenderTarget() { },
      render() { },
      readRenderTargetPixels() { },
    },
  };
  return { ...base, ...overrides };
}

/** The stub is intentionally not a real Gfx; it satisfies the ctor structurally. */
function newHeightfield(gfx: StubGfx): Heightfield {
  return new Heightfield(gfx as unknown as Gfx);
}

const WORLD = 2048;

/** Fill the CPU mirror by hand with h = a*x + b*z sampled at texel centres. */
function setPlane(hf: Heightfield, a: number, b: number, res = 32) {
  hf.cpuRes = res;
  hf.cpuTexel = WORLD / res;
  const dst = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    const z = hf.origin.y + (j + 0.5) * hf.cpuTexel;
    for (let i = 0; i < res; i++) {
      const x = hf.origin.x + (i + 0.5) * hf.cpuTexel;
      dst[j * res + i] = a * x + b * z;
    }
  }
  hf.heightCPU = dst;
  return hf;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Heightfield.heightAt", () => {
  it("returns 0 and flat normal when not baked (heightCPU null)", () => {
    const hf = newHeightfield(makeGfx());
    expect(hf.heightCPU).toBeNull();
    expect(hf.heightAt(100, -250)).toBe(0);
    const out = new THREE.Vector3();
    hf.normalAt(100, -250, out);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(1, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });

  it("reconstructs a plane exactly in the field interior", () => {
    const a = 0.15, b = -0.07;
    const hf = setPlane(newHeightfield(makeGfx()), a, b);
    for (const [x, z] of [[0, 0], [123, -456], [-700, 650], [888, 111]] as const) {
      expect(Math.abs(hf.heightAt(x, z) - (a * x + b * z))).toBeLessThan(1e-2);
    }
  });

  it("wraps toroidally outside the world bounds", () => {
    const a = 0.1, b = 0.05;
    const hf = setPlane(newHeightfield(makeGfx()), a, b);
    // The field wraps modulo world size, so +WORLD in x or z is the same sample.
    expect(hf.heightAt(100 + WORLD, 200)).toBeCloseTo(hf.heightAt(100, 200), 4);
    expect(hf.heightAt(100, 200 + WORLD)).toBeCloseTo(hf.heightAt(100, 200), 4);
    expect(hf.heightAt(-WORLD - 100, 200)).toBeCloseTo(hf.heightAt(-100, 200), 4);
  });

  it("handles non-finite-safe sampling near repeated wraps", () => {
    const hf = setPlane(newHeightfield(makeGfx()), 0.1, 0.1);
    expect(Number.isFinite(hf.heightAt(1e6, -1e6))).toBe(true);
  });
});

describe("Heightfield.normalAt", () => {
  it("is (0,1,0) on a flat plane", () => {
    const hf = setPlane(newHeightfield(makeGfx()), 0, 0);
    const out = new THREE.Vector3();
    hf.normalAt(10, 20, out);
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.y).toBeCloseTo(1, 5);
    expect(out.z).toBeCloseTo(0, 5);
  });

  it("tilts against the slope on h = a*x", () => {
    const a = 0.3;
    const hf = setPlane(newHeightfield(makeGfx()), a, 0);
    const out = new THREE.Vector3();
    hf.normalAt(0, 0, out);
    const len = Math.hypot(a, 1);
    expect(out.x).toBeCloseTo(-a / len, 3);
    expect(out.y).toBeCloseTo(1 / len, 3);
    expect(Math.abs(out.z)).toBeLessThan(1e-3);
    expect(out.length()).toBeCloseTo(1, 6);
  });

  it("tilts against the slope on h = b*z", () => {
    const b = 0.25;
    const hf = setPlane(newHeightfield(makeGfx()), 0, b);
    const out = new THREE.Vector3();
    hf.normalAt(0, 0, out);
    const len = Math.hypot(b, 1);
    expect(out.z).toBeCloseTo(-b / len, 3);
    expect(out.y).toBeCloseTo(1 / len, 3);
    expect(Math.abs(out.x)).toBeLessThan(1e-3);
  });

  it("supports compound slopes (x and z)", () => {
    const a = 0.2, b = -0.4;
    const hf = setPlane(newHeightfield(makeGfx()), a, b);
    const out = new THREE.Vector3();
    hf.normalAt(0, 0, out);
    const len = Math.sqrt(a * a + b * b + 1);
    expect(out.x).toBeCloseTo(-a / len, 3);
    expect(out.y).toBeCloseTo(1 / len, 3);
    expect(out.z).toBeCloseTo(-b / len, 3);
  });
});

describe("Heightfield readback contract", () => {
  it("starts with readbackError null", () => {
    const hf = newHeightfield(makeGfx());
    expect(hf.readbackError).toBeNull();
  });

  it("failure keeps heightCPU null, sets readbackError to the message, warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    const gfx = makeGfx();
    gfx.renderer.render = () => { throw new Error("boom"); };
    const hf = newHeightfield(gfx);
    await hf._readback();
    expect(hf.readbackError).toBe("boom");
    expect(hf.heightCPU).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    // Grounding degrades to flat, not crash.
    expect(hf.heightAt(0, 0)).toBe(0);
  });

  it("non-Error throwables are stringified into readbackError", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => { });
    const gfx = makeGfx();
    gfx.renderer.render = () => { throw "string failure"; }; // eslint-disable-line no-throw-literal
    const hf = newHeightfield(gfx);
    await hf._readback();
    expect(hf.readbackError).toBe("string failure");
    expect(hf.heightCPU).toBeNull();
  });

  it("success fills the mirror (2x2 box average), clears readbackError, measures relief", async () => {
    const RES = 4096;
    const a = 0.1, b = -0.05;
    const makeRT = (_n: string, _w: number, _h: number) => ({
      texture: new THREE.Texture(),
      dispose() { },
    });
    const gfx = makeGfx({ makeRenderTarget: makeRT });
    gfx.renderer.readRenderTargetPixels = (
      _rt: unknown, _x: number, _y: number, w: number, h: number, buf: Float32Array,
    ) => {
      // Simulate an RGBA32F readback of the bake: R = height, stride 4.
      for (let y = 0; y < h; y++) {
        const z = -1024 + (y + 0.5) * (2048 / RES);
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          const wx = -1024 + (x + 0.5) * (2048 / RES);
          buf[row + x * 4] = a * wx + b * z;
        }
      }
    };
    const hf = newHeightfield(gfx);
    // Poison the error state first to prove the success path clears it.
    hf.readbackError = "stale";
    await hf._readback();
    expect(hf.readbackError).toBeNull();
    expect(hf.heightCPU).not.toBeNull();
    expect(hf.cpuRes).toBe(RES / 2);
    expect(hf.cpuTexel).toBeCloseTo(1, 6);
    // The box average of a linear field is the plane at the CPU texel centres.
    expect(Math.abs(hf.heightAt(0, 0) - 0)).toBeLessThan(1e-2);
    expect(Math.abs(hf.heightAt(500, 300) - (a * 500 + b * 300))).toBeLessThan(1e-2);
    // Relief measured from the mirror, not assumed.
    expect(hf.minHeight).toBeLessThan(hf.maxHeight);
    expect(Number.isFinite(hf.minHeight)).toBe(true);
    expect(Number.isFinite(hf.maxHeight)).toBe(true);
    // Plane ranges over the field: min at (-1024, +1024) corner sign-wise.
    const corners = [
      a * -1024 + b * -1024, a * -1024 + b * 1024,
      a * 1024 + b * -1024, a * 1024 + b * 1024,
    ];
    expect(hf.minHeight).toBeLessThanOrEqual(Math.min(...corners) + 1);
    expect(hf.maxHeight).toBeGreaterThanOrEqual(Math.max(...corners) - 1);
  }, 30000);
});
