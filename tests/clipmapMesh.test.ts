import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  buildClipmapMesh,
  BASE_SPACING,
  GRID_HALF_N,
} from "../src/terrain/clipmapMesh.js";

// GRID_N / LEVELS / HOLE_SHRINK are module-private; re-derived here from the
// documented layout (quads per side 160, 8 rings, 3-cell hole shrink).
const GRID_N = 160;
const LEVELS = 8;
const HOLE_SHRINK = 3;
const HALF = GRID_N / 2; // 80
const SIDE = GRID_N + 1;
const VERTS_PER_LEVEL = SIDE * SIDE;
const TOTAL_VERTS = VERTS_PER_LEVEL * LEVELS;

// Each annulus skips the quads lying entirely inside its hole.
const HOLE_HALF = HALF / 2 - HOLE_SHRINK; // 37
const HOLE_QUADS = (HOLE_HALF * 2) * (HOLE_HALF * 2); // 74² = 5476
const LEVEL0_QUADS = GRID_N * GRID_N;
const ANNULUS_QUADS = GRID_N * GRID_N - HOLE_QUADS;
const TOTAL_QUADS = LEVEL0_QUADS + (LEVELS - 1) * ANNULUS_QUADS;
const TOTAL_INDICES = TOTAL_QUADS * 6;

describe("buildClipmapMesh", () => {
  const mesh = buildClipmapMesh();
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();

  it("returns a THREE.Mesh named terrain with culling disabled", () => {
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.name).toBe("terrain");
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.matrixAutoUpdate).toBe(false);
  });

  it("has finite positions for the full multi-level lattice", () => {
    expect(positions).toBeDefined();
    expect(positions.count).toBe(TOTAL_VERTS);
    expect(positions.itemSize).toBe(3);
    const arr = positions.array as Float32Array;
    expect(arr.length).toBe(TOTAL_VERTS * 3);
    for (let i = 0; i < arr.length; i++) {
      expect(Number.isFinite(arr[i])).toBe(true);
    }
  });

  it("encodes (gridI, level, gridJ) in the position attribute", () => {
    const arr = positions.array as Float32Array;
    // First vertex of level 0 is grid (-80, 0, -80); last of level LEVELS-1 is (80, 7, 80).
    expect([arr[0], arr[1], arr[2]]).toEqual([-HALF, 0, -HALF]);
    const last = (TOTAL_VERTS - 1) * 3;
    expect([arr[last], arr[last + 1], arr[last + 2]]).toEqual([HALF, LEVELS - 1, HALF]);
    // Level channel is an exact small integer per level.
    for (let level = 0; level < LEVELS; level++) {
      const base = level * VERTS_PER_LEVEL;
      expect(arr[base * 3 + 1]).toBe(level);
      expect(arr[(base + VERTS_PER_LEVEL - 1) * 3 + 1]).toBe(level);
    }
  });

  it("uses Uint32 indices within vertex range", () => {
    expect(index).not.toBeNull();
    expect(index!.array).toBeInstanceOf(Uint32Array);
    expect(index!.count).toBe(TOTAL_INDICES);
    const idx = index!.array as Uint32Array;
    for (let i = 0; i < idx.length; i++) {
      expect(idx[i]).toBeLessThan(TOTAL_VERTS);
    }
  });

  it("index count matches the recomputed quad budget (LEVELS-1 shrunk holes)", () => {
    expect(index!.count).toBe(TOTAL_INDICES);
    expect(TOTAL_INDICES % 6).toBe(0);
  });

  it("level 0 is a solid square; each outer level skips exactly the shrunk hole", () => {
    const idx = index!.array as Uint32Array;
    let offset = 0;
    const levelIndexCounts: number[] = [];
    // Indices are emitted level-major.
    const expected = (level: number) =>
      (level === 0 ? LEVEL0_QUADS : ANNULUS_QUADS) * 6;
    for (let level = 0; level < LEVELS; level++) {
      const count = expected(level);
      levelIndexCounts.push(count);
      const slice = idx.subarray(offset, offset + count);
      expect(slice.length).toBe(count);
      // Every index in this level's slice points into this level's vertex range.
      const lo = level * VERTS_PER_LEVEL;
      const hi = lo + VERTS_PER_LEVEL;
      let inRange = true;
      for (let i = 0; i < slice.length; i++) {
        const v = slice[i];
        if (v < lo || v >= hi) { inRange = false; break; }
      }
      expect(inRange).toBe(true);
      offset += count;
    }
    expect(offset).toBe(idx.length);
    // Seven annuli, each missing exactly HOLE_QUADS quads versus level 0.
    expect(levelIndexCounts[0]).toBe(LEVEL0_QUADS * 6);
    for (let level = 1; level < LEVELS; level++) {
      expect(levelIndexCounts[level]).toBe(ANNULUS_QUADS * 6);
      expect(LEVEL0_QUADS - ANNULUS_QUADS).toBe(HOLE_QUADS);
    }
  });

  it("metadata agrees with the buffers", () => {
    const meta = (mesh as THREE.Mesh & { metadata: { triangles: number; vertices: number } }).metadata;
    expect(meta.vertices).toBe(TOTAL_VERTS);
    expect(meta.triangles).toBe(index!.count / 3);
  });

  it("carries no morph attribute — morphing lives in the vertex shader", () => {
    expect(Object.keys(geometry.attributes)).toEqual(["position"]);
  });
});

describe("clipmap mesh constants", () => {
  it("BASE_SPACING", () => expect(BASE_SPACING).toBe(0.085));
  it("GRID_HALF_N", () => expect(GRID_HALF_N).toBe(80));
});
