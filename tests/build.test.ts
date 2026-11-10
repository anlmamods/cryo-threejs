/**
 * Generated-geometry coverage for src/character/build.ts: index ranges,
 * finite attributes, normal quality, material-id ranges, UVs, skinning data
 * and `CharacterMeshMetadata` consistency with the actual buffers.
 * `build*` never touch GL — the `gfx` param is unused; pass a null cast.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildBody, buildFur, buildClothMesh, M_ROBE, M_MANTLE } from "../src/character/build.js";
import { makePanels } from "../src/character/cloth.js";
import { BONE_COUNT } from "../src/character/figure.js";

const GFX = null as never; // `Gfx` param is unused by every builder

type BuilderMesh = THREE.Mesh & {
  metadata: { triangles: number; vertices?: number; fur?: boolean };
};

const attr = (m: BuilderMesh, name: string) =>
  m.geometry.getAttribute(name) as THREE.BufferAttribute;

const index = (m: BuilderMesh) => m.geometry.getIndex()!;

function expectIndexIntegrity(m: BuilderMesh) {
  const idx = index(m);
  expect(idx.count % 3).toBe(0);
  expect(idx).toBeInstanceOf(THREE.BufferAttribute);
  expect(idx.array.constructor.name).toBe("Uint32Array");
  const vCount = attr(m, "position").count;
  const arr = idx.array as unknown as { length: number;[i: number]: number };
  for (let i = 0; i < arr.length; i++) {
    expect(Number.isInteger(arr[i])).toBe(true);
    expect(arr[i]).toBeGreaterThanOrEqual(0);
    expect(arr[i]).toBeLessThan(vCount);
  }
}

function expectFinite(m: BuilderMesh, name: string) {
  const a = attr(m, name);
  for (let i = 0; i < a.array.length; i++) {
    expect(Number.isFinite((a.array as Float32Array)[i])).toBe(true);
  }
}

function expectUnitNormals(m: BuilderMesh, tol = 1e-3) {
  const n = attr(m, "normal");
  for (let i = 0; i < n.count; i++) {
    const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
    expect(Math.abs(len - 1)).toBeLessThan(tol);
  }
}

function expectMetadataMatchesBuffers(m: BuilderMesh) {
  expect(BONE_COUNT).toBe(18); // the 18-bone contract
  expect(m.metadata.triangles).toBe(index(m).count / 3);
  expect(m.metadata.vertices).toBe(attr(m, "position").count);
}

function expectSkinning(m: BuilderMesh) {
  const bi = attr(m, "boneIdx");
  const bw = attr(m, "boneWt");
  expect(bi.count).toBe(attr(m, "position").count);
  expect(bw.count).toBe(attr(m, "position").count);
  for (let i = 0; i < bi.count; i++) {
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      const b = bi.getComponent(i, j);
      const w = bw.getComponent(i, j);
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(BONE_COUNT); // 18 bones, no out-of-range ids
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      sum += w;
    }
    expect(Math.abs(sum - 1)).toBeLessThan(1e-5); // weights normalized
    expect(bi.getComponent(i, 2)).toBe(0);
    expect(bi.getComponent(i, 3)).toBe(0);
    expect(bw.getComponent(i, 2)).toBe(0);
    expect(bw.getComponent(i, 3)).toBe(0);
  }
}
describe("buildBody", () => {
  const mesh = buildBody(GFX) as BuilderMesh;

  it("attaches finite positions/normals with unit-length normals", () => {
    expectFinite(mesh, "position");
    expectFinite(mesh, "normal");
    expectUnitNormals(mesh);
  });

  it("keeps every index inside the vertex buffer", () => {
    expectIndexIntegrity(mesh);
  });

  it("writes material ids in [0..6] and occlusion in [0..1]", () => {
    const aux = attr(mesh, "aux");
    for (let i = 0; i < aux.count; i++) {
      const mat = aux.getX(i);
      expect(Number.isInteger(mat)).toBe(true);
      expect(mat).toBeGreaterThanOrEqual(0);
      expect(mat).toBeLessThanOrEqual(6);
      expect(aux.getY(i)).toBeGreaterThanOrEqual(0);
      expect(aux.getY(i)).toBeLessThanOrEqual(1);
    }
  });

  it("skins with 18-bone indices and normalized two-influence weights", () => {
    expectSkinning(mesh);
  });

  it("produces non-negative surface-metre UVs", () => {
    const uv = attr(mesh, "uv");
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps bind-pose geometry inside roughly the figure's measured volume", () => {
    const pos = attr(mesh, "position");
    let maxY = -Infinity, minY = Infinity, maxR = 0;
    for (let i = 0; i < pos.count; i++) {
      maxY = Math.max(maxY, pos.getY(i));
      minY = Math.min(minY, pos.getY(i));
      maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
    expect(maxY).toBeGreaterThan(1.5); // head tops out above the chest
    expect(maxY).toBeLessThan(2.2);
    expect(minY).toBeGreaterThan(-0.3);
    expect(maxR).toBeLessThan(1.5); // limbs reach out, but not by a metre
  });

  it("metadata matches the buffers and is not flagged as fur", () => {
    expectMetadataMatchesBuffers(mesh);
    expect(mesh.metadata.fur).toBeFalsy();
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.matrixAutoUpdate).toBe(false);
  });
});

describe("buildFur", () => {
  const mesh = buildFur(GFX) as BuilderMesh;

  it("attaches finite positions/normals and in-range indices", () => {
    expectFinite(mesh, "position");
    expectFinite(mesh, "normal");
    expectIndexIntegrity(mesh);
  });

  it("normals stay near unit length (shell fur authors them unnormalized)", () => {
    const n = attr(mesh, "normal");
    for (let i = 0; i < n.count; i++) {
      const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      expect(len).toBeGreaterThan(0.5);
      expect(len).toBeLessThan(1.5);
    }
  });

  it("carries the shell parameter in the matId slot, in [0..1]", () => {
    const aux = attr(mesh, "aux");
    for (let i = 0; i < aux.count; i++) {
      expect(aux.getX(i)).toBeGreaterThanOrEqual(0);
      expect(aux.getX(i)).toBeLessThanOrEqual(1);
      expect(aux.getY(i)).toBeGreaterThanOrEqual(0);
      expect(aux.getY(i)).toBeLessThanOrEqual(1);
    }
  });

  it("skins with 18-bone indices and normalized weights", () => {
    expectSkinning(mesh);
  });

  it("metadata matches the buffers and is flagged as fur", () => {
    expectMetadataMatchesBuffers(mesh);
    expect(mesh.metadata.fur).toBe(true);
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.matrixAutoUpdate).toBe(false);
  });
});

describe("buildClothMesh", () => {
  const panels = makePanels();
  const mesh = buildClothMesh(GFX, panels) as BuilderMesh;

  it("keeps every index inside the vertex buffer", () => {
    expectIndexIntegrity(mesh);
  });

  it("lays each panel on its own plane (z = panel index) with unit-square u/v", () => {
    const pos = attr(mesh, "position");
    const seen = new Set<number>();
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      expect(Number.isInteger(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThan(panels.length);
      seen.add(z);
      expect(pos.getX(i)).toBeGreaterThanOrEqual(0);
      expect(pos.getX(i)).toBeLessThanOrEqual(1);
      expect(pos.getY(i)).toBeGreaterThanOrEqual(0);
      expect(pos.getY(i)).toBeLessThanOrEqual(1);
    }
    expect(seen.size).toBe(panels.length);
  });

  it("gives every panel a contiguous, non-overlapping vertex range", () => {
    const pos = attr(mesh, "position");
    let base = 0;
    for (let p = 0; p < panels.length; p++) {
      const count = (panels[p].renderCols + 1) * (panels[p].renderRows + 1);
      for (let i = 0; i < count; i++) {
        expect(pos.getZ(base + i)).toBe(p);
      }
      base += count;
    }
    expect(base).toBe(pos.count);
  });

  it("tiles u/v by each panel's weave scale", () => {
    const pos = attr(mesh, "position");
    const uv = attr(mesh, "uv");
    for (let i = 0; i < pos.count; i++) {
      const panel = panels[pos.getZ(i)];
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(panel.weaveU + 1e-4);
      expect(uv.getY(i)).toBeLessThanOrEqual(panel.weaveV + 1e-4);
    }
  });

  it("writes the panel's material id and a hem AO ramp from aoTop to aoBottom", () => {
    const pos = attr(mesh, "position");
    const aux = attr(mesh, "aux");
    expect(M_ROBE).toBe(0);
    expect(M_MANTLE).toBe(1);
    for (let i = 0; i < pos.count; i++) {
      const panel = panels[pos.getZ(i)];
      expect(aux.getX(i)).toBe(panel.matId);
      expect(aux.getX(i)).toBeLessThanOrEqual(6);
      const v = pos.getY(i);
      const expectedAo = panel.aoTop + (panel.aoBottom - panel.aoTop) * v;
      expect(aux.getY(i)).toBeCloseTo(expectedAo, 6);
      if (v === 0) expect(aux.getY(i)).toBeCloseTo(panel.aoTop, 6);
      if (v === 1) expect(aux.getY(i)).toBeCloseTo(panel.aoBottom, 6);
    }
  });

  it("metadata matches the buffers and the panel grid dimensions", () => {
    expectMetadataMatchesBuffers(mesh);
    let verts = 0, tris = 0;
    for (const p of panels) {
      verts += (p.renderCols + 1) * (p.renderRows + 1);
      tris += p.renderCols * p.renderRows * 2;
    }
    expect(mesh.metadata.vertices).toBe(verts);
    expect(mesh.metadata.triangles).toBe(tris);
    expect(mesh.geometry.getIndex()!.count).toBe(tris * 3);
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.matrixAutoUpdate).toBe(false);
  });

  it("has no normal attribute — normals come from the shader's Catmull-Rom reconstruction", () => {
    expect(mesh.geometry.getAttribute("normal")).toBeUndefined();
  });
});
