import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { DeformationField } from "../src/terrain/deformation.js";
import type { Gfx } from "../src/core/gfx.js";

/** Structural stand-in for the slice of Gfx the deformation field touches. */
interface StubGfx {
  caps: { floatLinear: boolean };
  makeRenderTarget: (
    name: string, w: number, h: number, opts?: unknown,
  ) => { texture: THREE.Texture; dispose(): void };
  renderer: {
    setRenderTarget(target: unknown): void;
    render(scene: unknown, camera: unknown): void;
  };
}

function makeGfx(): StubGfx {
  return {
    caps: { floatLinear: true },
    makeRenderTarget: (_name: string, _w: number, _h: number, _opts?: unknown) => ({
      texture: new THREE.Texture(),
      dispose() { },
    }),
    renderer: {
      setRenderTarget() { },
      render() { },
    },
  };
}

function newField(gfx: StubGfx): DeformationField {
  return new DeformationField(gfx as unknown as Gfx);
}

const MAX_BRUSHES = 96;
const STRIDE = MAX_BRUSHES * 4;

let gfx: StubGfx;
let field: DeformationField;

beforeEach(() => {
  gfx = makeGfx();
  field = newField(gfx);
});

describe("DeformationField.brush", () => {
  it("rejects radius <= 0", () => {
    field.brush(0, 0, 0, 0.2, 0.1, 0.5, 0);
    field.brush(0, 0, -1, 0.2, 0.1, 0.5, 0);
    expect(field._brushCount).toBe(0);
    expect(field._brushDirty).toBe(false);
  });

  it("accepts the exact radius > 0 boundary", () => {
    field.brush(0, 0, 1e-6, 0.2, 0.1, 0.5, 0);
    expect(field._brushCount).toBe(1);
  });

  it("drops brushes entirely outside the window + reach", () => {
    // Window is 80 m across, centred on (0,0); reach is 2 radii beyond the edge.
    const half = field.size * 0.5;
    field.brush(half + 2 * 1 + 0.01, 0, 1, 0.2, 0.1, 0.5, 0); // x just out of reach
    field.brush(0, -(half + 2 * 1 + 0.01), 1, 0.2, 0.1, 0.5, 0); // z just out of reach
    expect(field._brushCount).toBe(0);
    // Just inside the reach still lands.
    field.brush(half + 2 * 1 - 0.01, 0, 1, 0.2, 0.1, 0.5, 0);
    field.brush(0, -(half + 2 * 1 - 0.01), 1, 0.2, 0.1, 0.5, 0);
    expect(field._brushCount).toBe(2);
  });

  it("respects the window centre when testing reach", () => {
    field.center.set(1000, 1000);
    field.brush(0, 0, 1, 0.2, 0.1, 0.5, 0); // far from the moved window
    expect(field._brushCount).toBe(0);
    field.brush(1000, 1000, 1, 0.2, 0.1, 0.5, 0);
    expect(field._brushCount).toBe(1);
  });

  it("drops brushes once the window is full", () => {
    for (let i = 0; i < MAX_BRUSHES; i++) {
      field.brush((i % 10) * 0.1 - 0.5, Math.floor(i / 10) * 0.1 - 0.5, 0.5, 0.1, 0.05, 0.5, 0);
    }
    expect(field._brushCount).toBe(MAX_BRUSHES);
    field.brush(0, 0, 0.5, 0.1, 0.05, 0.5, 0);
    expect(field._brushCount).toBe(MAX_BRUSHES);
  });

  it("writes the three 4-float rows at the right strides", () => {
    const x = 3, z = 7, radius = 1.5, depth = 0.2, berm = 0.3;
    const compression = 0.5, ice = 0.25, yaw = 0.3, elongation = 2, edge = 0.7;
    field.brush(x, z, radius, depth, berm, compression, ice, yaw, elongation, edge);
    expect(field._brushCount).toBe(1);
    const d = field._brushData;
    // Row 0: x, z, radius, elongation
    expect(d[0]).toBe(x);
    expect(d[1]).toBe(z);
    expect(d[2]).toBe(radius);
    expect(d[3]).toBe(elongation);
    // Row 1: cos(yaw), sin(yaw), depth, berm
    expect(d[STRIDE + 0]).toBeCloseTo(Math.cos(yaw), 6);
    expect(d[STRIDE + 1]).toBeCloseTo(Math.sin(yaw), 6);
    expect(d[STRIDE + 2]).toBeCloseTo(depth, 6);
    expect(d[STRIDE + 3]).toBeCloseTo(berm, 6);
    expect(d[2 * STRIDE + 0]).toBeCloseTo(compression, 6);
    expect(d[2 * STRIDE + 1]).toBeCloseTo(ice, 6);
    expect(d[2 * STRIDE + 2]).toBeCloseTo(edge, 6);
    expect(d[2 * STRIDE + 3]).toBeCloseTo((x * 0.37 + z * 0.71) % 100, 6);
    expect(field._brushDirty).toBe(true);
  });

  it("defaults yaw to 0, elongation to 1 and edge to 1 when omitted", () => {
    field.brush(1, 2, 0.5, 0.1, 0.05, 0.5, 0);
    const d = field._brushData;
    expect(d[3]).toBe(1); // elongation
    expect(d[STRIDE + 0]).toBeCloseTo(1, 6); // cos(0)
    expect(d[STRIDE + 1]).toBeCloseTo(0, 6); // sin(0)
    expect(d[2 * STRIDE + 2]).toBe(1); // edge
  });

  it("respects an explicit edge of 0", () => {
    field.brush(1, 2, 0.5, 0.1, 0.05, 0.5, 0, 0, 1, 0);
    expect(field._brushData[2 * STRIDE + 2]).toBe(0);
  });

  it("seed is deterministic in x,z and decorrelates between points", () => {
    field.brush(3, 7, 0.5, 0.1, 0.05, 0.5, 0);
    field.brush(3, 8, 0.5, 0.1, 0.05, 0.5, 0);
    const d = field._brushData;
    expect(d[2 * STRIDE + 3]).toBeCloseTo((3 * 0.37 + 7 * 0.71) % 100, 6);
    expect(d[2 * STRIDE + 4 + 3]).toBeCloseTo((3 * 0.37 + 8 * 0.71) % 100, 6);
    // Distinct silhouettes for distinct footprints.
    expect(d[2 * STRIDE + 3]).not.toBe(d[2 * STRIDE + 4 + 3]);
  });

  it("queues multiple brushes at successive slots", () => {
    field.brush(0, 0, 0.5, 0.1, 0.05, 0.5, 0);
    field.brush(1, 1, 0.5, 0.1, 0.05, 0.5, 0);
    expect(field._brushCount).toBe(2);
    expect(field._brushData[4]).toBe(1); // second brush x lands at slot 1
  });
});

describe("DeformationField.update", () => {
  const t = () => field.texel;

  it("texel-snaps the window centre to integer texel multiples", () => {
    field.update(1 / 60, { x: 2.4 * t(), z: -1.6 * t() });
    expect(field.center.x).toBeCloseTo(Math.round(2.4) * t(), 6);
    expect(field.center.y).toBeCloseTo(Math.round(-1.6) * t(), 6);
  });

  it("sub-half-texel focus moves do not move the window; half-texel moves snap it", () => {
    field.update(1 / 60, { x: 0, z: 0 });
    expect(field.center.x).toBe(0);
    // 0.4 texel — below the rounding threshold.
    field.update(1 / 60, { x: 0.4 * t(), z: 0 });
    expect(field.center.x).toBe(0);
    // 0.6 texel — past half a texel, the window jumps one texel.
    field.update(1 / 60, { x: 0.6 * t(), z: 0 });
    expect(field.center.x).toBeCloseTo(t(), 6);
  });

  it("prevCenter tracks the previous snapped centre", () => {
    field.update(1 / 60, { x: 0, z: 0 });
    field.update(1 / 60, { x: 10 * t(), z: -4 * t() });
    expect(field._prevCenter.x).toBe(0);
    expect(field._prevCenter.y).toBe(0);
    expect(field.center.x).toBeCloseTo(10 * t(), 6);
    expect(field.center.y).toBeCloseTo(-4 * t(), 6);
  });

  it("banks relaxation time and only spends it in >= 0.4 s chunks", () => {
    const u = field._pass.material.uniforms;
    field.update(0.1, { x: 0, z: 0 });
    expect(field._relaxOwed).toBeCloseTo(0.1, 6);
    expect(u.dt.value).toBe(0);
    field.update(0.1, { x: 0, z: 0 });
    field.update(0.1, { x: 0, z: 0 });
    expect(u.dt.value).toBe(0);
    expect(field._relaxOwed).toBeCloseTo(0.3, 6);
    field.update(0.15, { x: 0, z: 0 });
    // 0.45 banked — spent in one go, nothing left over.
    expect(u.dt.value).toBeCloseTo(0.45, 6);
    expect(field._relaxOwed).toBe(0);
    // Next frame goes back to banking.
    field.update(0.1, { x: 0, z: 0 });
    expect(u.dt.value).toBe(0);
    expect(field._relaxOwed).toBeCloseTo(0.1, 6);
  });

  it("clears _brushDirty and zeroes the tail of the brush table on upload", () => {
    field.brush(0, 0, 0.5, 0.1, 0.05, 0.5, 0);
    expect(field._brushDirty).toBe(true);
    const queued = field._brushCount;
    expect(queued).toBe(1);
    field.update(1 / 60, { x: 0, z: 0 });
    expect(field._brushDirty).toBe(false);
    // Stale radii beyond the live count must be zeroed so the shader skips them.
    const d = field._brushData;
    for (let i = queued; i < MAX_BRUSHES; i++) {
      expect(d[i * 4 + 2]).toBe(0);
    }
    // The live slot keeps its radius.
    expect(d[2]).toBeCloseTo(0.5, 6);
  });

  it("resets the brush queue after the pass consumes it", () => {
    field.brush(0, 0, 0.5, 0.1, 0.05, 0.5, 0);
    field.brush(1, 1, 0.5, 0.1, 0.05, 0.5, 0);
    const u = field._pass.material.uniforms;
    field.update(1 / 60, { x: 0, z: 0 });
    expect(u.brushCount.value).toBe(2); // pass saw both brushes
    expect(field._brushCount).toBe(0); // queue drained for the next frame
  });

  it("returns the current state texture and ping-pongs targets", () => {
    const first = field.update(1 / 60, { x: 0, z: 0 });
    const second = field.update(1 / 60, { x: 0, z: 0 });
    expect(first).toBeInstanceOf(THREE.Texture);
    expect(second).toBeInstanceOf(THREE.Texture);
    expect(first).not.toBe(second);
  });
});
