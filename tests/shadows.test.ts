import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ShadowSystem, CASCADE_COUNT } from "../src/render/shadows.js";
import { lookAtLH, perspectiveFovLH } from "../src/core/mat4.js";
import type { Gfx } from "../src/core/gfx.js";

/** Structural stand-in for the slice of Gfx the shadow system touches:
 *  caps (filter choice) + makeRenderTarget (one per cascade). */
interface StubGfx {
  caps: { floatLinear: boolean };
  makeRenderTarget: (
    name: string, w: number, h: number, opts?: { filter?: THREE.MagnificationTextureFilter },
  ) => { texture: THREE.Texture; dispose(): void };
  targets: { name: string, w: number, h: number, opts?: { filter?: THREE.MagnificationTextureFilter } }[];
}

function makeGfx(floatLinear = true): StubGfx {
  const targets: StubGfx["targets"] = [];
  return {
    caps: { floatLinear },
    targets,
    makeRenderTarget(name: string, w: number, h: number, opts?: { filter?: THREE.MagnificationTextureFilter }) {
      targets.push({ name, w, h, opts });
      return { texture: new THREE.Texture(), dispose() { } };
    },
  };
}

function newShadows(gfx: StubGfx = makeGfx()): ShadowSystem {
  return new ShadowSystem(gfx as unknown as Gfx);
}

interface CameraLike {
  view: THREE.Matrix4;
  projection: THREE.Matrix4;
  minZ: number;
  maxZ: number;
}

/** A plausible rig camera: eye at origin-ish, LH +Z forward, ~58 deg fov. */
function makeCamera(eye = { x: 0, y: 8, z: -30 }, yaw = 0): CameraLike {
  const minZ = 0.1;
  const maxZ = 600;
  const view = new THREE.Matrix4();
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  lookAtLH(
    view.elements,
    eye.x, eye.y, eye.z,
    eye.x + fx * 100, eye.y - 2, eye.z + fz * 100,
    0, 1, 0,
  );
  const projection = new THREE.Matrix4();
  perspectiveFovLH(projection.elements, Math.PI / 3.2, 16 / 9, minZ, maxZ);
  return { view, projection, minZ, maxZ };
}

const SUN = new THREE.Vector3(0.35, 0.8, 0.45).normalize();

describe("ShadowSystem constructor", () => {
  it("requests one float render target per cascade at full resolution", () => {
    const gfx = makeGfx();
    const sys = newShadows(gfx);
    expect(gfx.targets).toHaveLength(CASCADE_COUNT);
    for (const t of gfx.targets) {
      expect(t.w).toBe(sys.resolution);
      expect(t.h).toBe(sys.resolution);
    }
    expect(sys.maps).toHaveLength(CASCADE_COUNT);
    expect(sys.matrices).toHaveLength(CASCADE_COUNT);
    expect(sys.params).toHaveLength(CASCADE_COUNT);
  });

  it("honours the float-linear caps flag for the target filter", () => {
    const linear = makeGfx(true);
    const nearest = makeGfx(false);
    newShadows(linear);
    newShadows(nearest);
    // The ctor picks the filter from caps; both must still produce targets.
    expect(linear.targets).toHaveLength(CASCADE_COUNT);
    expect(nearest.targets).toHaveLength(CASCADE_COUNT);
    const linFilter = linear.targets[0].opts?.filter;
    const nearFilter = nearest.targets[0].opts?.filter;
    expect(linFilter).toBe(THREE.LinearFilter);
    expect(nearFilter).toBe(THREE.NearestFilter);
  });

  it("split distances are positive, monotonic non-decreasing, and the tail repeats the last split", () => {
    const sys = newShadows();
    expect(sys.splits).toHaveLength(CASCADE_COUNT + 1);
    for (let i = 0; i < CASCADE_COUNT; i++) {
      expect(Number.isFinite(sys.splits[i])).toBe(true);
      expect(sys.splits[i]).toBeGreaterThan(0);
      expect(sys.splits[i + 1]).toBeGreaterThanOrEqual(sys.splits[i]);
    }
    // The 4th component is the last cascade's own far plane.
    expect(sys.splits[CASCADE_COUNT]).toBe(sys.splits[CASCADE_COUNT - 1]);
    expect(sys.splitsVec4.x).toBe(sys.splits[0]);
    expect(sys.splitsVec4.y).toBe(sys.splits[1]);
    expect(sys.splitsVec4.z).toBe(sys.splits[2]);
    expect(sys.splitsVec4.w).toBe(sys.splits[3]);
  });

  it("texelSize is positive and the inverse of the map resolution", () => {
    const sys = newShadows();
    expect(sys.texelSize).toBeGreaterThan(0);
    expect(sys.texelSize).toBeCloseTo(1 / sys.resolution, 12);
    expect(sys.texelSize * sys.resolution).toBeCloseTo(1, 12);
  });

  it("starts with conservative height bounds and an identity matrixData", () => {
    const sys = newShadows();
    expect(sys.minHeight).toBeLessThan(0);
    expect(sys.maxHeight).toBeGreaterThan(0);
    expect(sys.minHeight).toBeLessThan(sys.maxHeight);
    for (let c = 0; c < CASCADE_COUNT; c++) {
      const el = sys.matrices[c].elements;
      // Identity per cascade at construction.
      expect(el[0]).toBe(1); expect(el[5]).toBe(1); expect(el[10]).toBe(1); expect(el[15]).toBe(1);
      expect(el[1]).toBe(0); expect(el[4]).toBe(0); expect(el[12]).toBe(0);
    }
  });
});

describe("ShadowSystem matrixData aliasing", () => {
  it("matrices[c].elements is the same memory as the matrixData window", () => {
    const sys = newShadows();
    for (let c = 0; c < CASCADE_COUNT; c++) {
      const el = sys.matrices[c].elements as unknown as Float32Array;
      expect(el.buffer).toBe(sys.matrixData.buffer);
      expect(el.byteOffset).toBe(c * 16 * 4);
      expect(el.length).toBe(16);
    }
  });

  it("writes through matrices[c] are visible in matrixData and vice versa", () => {
    const sys = newShadows();
    const el = sys.matrices[1].elements as unknown as Float32Array;
    el[7] = 123.5;
    expect(sys.matrixData[16 + 7]).toBe(123.5);
    sys.matrixData[32 + 9] = -77.25;
    expect(sys.matrices[2].elements[9]).toBe(-77.25);
  });

  it("update() writes the cascade projections into the shared matrixData buffer", () => {
    const sys = newShadows();
    sys.update(makeCamera(), SUN);
    for (let c = 0; c < CASCADE_COUNT; c++) {
      for (let i = 0; i < 16; i++) {
        expect(sys.matrixData[c * 16 + i]).toBe(sys.matrices[c].elements[i]);
      }
    }
  });
});

describe("ShadowSystem.update", () => {
  it("produces finite view-projection matrices for every cascade", () => {
    const sys = newShadows();
    sys.update(makeCamera(), SUN);
    for (let i = 0; i < sys.matrixData.length; i++) {
      expect(Number.isFinite(sys.matrixData[i])).toBe(true);
    }
    for (const p of sys.params) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("lightDir points from the sun toward the scene (= -sunDir, normalized)", () => {
    const sys = newShadows();
    const sunDir = new THREE.Vector3(0, 2, 0); // not unit; update must normalize
    sys.update(makeCamera(), sunDir);
    expect(sys.lightDir.x).toBeCloseTo(0, 6);
    expect(sys.lightDir.y).toBeCloseTo(-1, 6);
    expect(sys.lightDir.z).toBeCloseTo(0, 6);
    expect(sys.lightDir.length()).toBeCloseTo(1, 6);
  });

  it("wider cascades get wider ortho boxes (params y grows with cascade index)", () => {
    const sys = newShadows();
    sys.update(makeCamera(), SUN);
    for (let c = 1; c < CASCADE_COUNT; c++) {
      expect(sys.params[c].y).toBeGreaterThan(sys.params[c - 1].y);
    }
    // Depth ranges stay positive for every cascade.
    for (let c = 0; c < CASCADE_COUNT; c++) {
      expect(sys.params[c].x).toBeGreaterThan(0);
    }
  });

  it("mirrors params into paramData for the uniform upload", () => {
    const sys = newShadows();
    sys.update(makeCamera(), SUN);
    for (let c = 0; c < CASCADE_COUNT; c++) {
      // paramData is Float32; params holds f64 copies of the same values.
      expect(sys.paramData[c * 4 + 0]).toBeCloseTo(sys.params[c].x, 4);
      expect(sys.paramData[c * 4 + 1]).toBeCloseTo(sys.params[c].y, 4);
      expect(sys.paramData[c * 4 + 2]).toBe(sys.params[c].z);
      expect(sys.paramData[c * 4 + 3]).toBe(sys.params[c].w);
    }
  });

  it("is deterministic for a fixed camera and sun", () => {
    const a = newShadows();
    const b = newShadows();
    const camA = makeCamera();
    const camB = makeCamera();
    a.update(camA, SUN);
    b.update(camB, SUN);
    expect(Array.from(a.matrixData)).toEqual(Array.from(b.matrixData));
    expect(a.params.map(p => p.x)).toEqual(b.params.map(p => p.x));
  });

  it("survives a near-zenith sun (up-vector guard) with finite output", () => {
    const sys = newShadows();
    sys.update(makeCamera(), new THREE.Vector3(0.001, 1, 0.001).normalize());
    for (let i = 0; i < sys.matrixData.length; i++) {
      expect(Number.isFinite(sys.matrixData[i])).toBe(true);
    }
  });

  it("survives a grazing sun (depth-solve clamp) with finite output", () => {
    const sys = newShadows();
    sys.update(makeCamera(), new THREE.Vector3(1, 0.01, 0.2).normalize());
    for (let i = 0; i < sys.matrixData.length; i++) {
      expect(Number.isFinite(sys.matrixData[i])).toBe(true);
    }
    for (const p of sys.params) expect(p.x).toBeGreaterThan(0);
  });

  it("fits cascades when the camera faces the opposite direction", () => {
    const sys = newShadows();
    sys.update(makeCamera({ x: 5, y: 12, z: 40 }, Math.PI * 0.75), SUN);
    for (let i = 0; i < sys.matrixData.length; i++) {
      expect(Number.isFinite(sys.matrixData[i])).toBe(true);
    }
  });

  it("does not mutate the split table", () => {
    const sys = newShadows();
    const before = Array.from(sys.splits);
    sys.update(makeCamera(), SUN);
    expect(Array.from(sys.splits)).toEqual(before);
  });
});

describe("ShadowSystem.setHeightBounds", () => {
  it("stores the supplied bounds verbatim", () => {
    const sys = newShadows();
    sys.setHeightBounds(-12.5, 34);
    expect(sys.minHeight).toBe(-12.5);
    expect(sys.maxHeight).toBe(34);
  });

  it("narrowing the height range does not widen the light-volume depth range", () => {
    const wide = newShadows();
    wide.setHeightBounds(-200, 200);
    const tight = newShadows();
    tight.setHeightBounds(3, 5);
    const camA = makeCamera();
    const camB = makeCamera();
    wide.update(camA, SUN);
    tight.update(camB, SUN);
    for (let c = 0; c < CASCADE_COUNT; c++) {
      expect(tight.params[c].x).toBeLessThanOrEqual(wide.params[c].x + 1e-4);
    }
  });

  it("still yields finite matrices with a tight height band", () => {
    const sys = newShadows();
    sys.setHeightBounds(0, 2);
    sys.update(makeCamera(), SUN);
    for (let i = 0; i < sys.matrixData.length; i++) {
      expect(Number.isFinite(sys.matrixData[i])).toBe(true);
    }
  });
});

describe("ShadowSystem caster bookkeeping", () => {
  function casterMaterial() {
    return new THREE.RawShaderMaterial({
      uniforms: { lightViewProjection: { value: null as THREE.Matrix4 | null } },
      vertexShader: "void main() {}",
      fragmentShader: "void main() {}",
    });
  }

  it("registers into every cascade by default and dedupes shared materials", () => {
    const sys = newShadows();
    const mesh = new THREE.Mesh();
    const shared = casterMaterial();
    sys.registerCaster(mesh, () => shared);
    for (let c = 0; c < CASCADE_COUNT; c++) {
      expect(sys._casters[c]).toHaveLength(1);
      expect(sys._casters[c][0].mesh).toBe(mesh);
      expect(sys._casters[c][0].material).toBe(shared);
    }
    expect(sys.materials).toEqual([shared]);
  });

  it("limits registration to the requested number of near cascades", () => {
    const sys = newShadows();
    const mesh = new THREE.Mesh();
    const seen: number[] = [];
    sys.registerCaster(mesh, (c) => { seen.push(c); return casterMaterial(); }, 2);
    expect(seen).toEqual([0, 1]);
    expect(sys._casters[0]).toHaveLength(1);
    expect(sys._casters[1]).toHaveLength(1);
    expect(sys._casters[2]).toHaveLength(0);
  });

  it("clamps an over-large cascade count to CASCADE_COUNT", () => {
    const sys = newShadows();
    const mesh = new THREE.Mesh();
    sys.registerCaster(mesh, () => casterMaterial(), 99);
    for (let c = 0; c < CASCADE_COUNT; c++) {
      expect(sys._casters[c]).toHaveLength(1);
    }
  });

  it("ignores null/undefined meshes, makers and maker results", () => {
    const sys = newShadows();
    const mesh = new THREE.Mesh();
    sys.registerCaster(null as unknown as THREE.Mesh, () => casterMaterial());
    sys.registerCaster(mesh, null as unknown as (c: number) => THREE.Material);
    sys.registerCaster(mesh, () => undefined as unknown as THREE.Material);
    for (let c = 0; c < CASCADE_COUNT; c++) expect(sys._casters[c]).toHaveLength(0);
    expect(sys.materials).toHaveLength(0);
  });

  it("keeps per-cascade materials distinct when the maker hands out new ones", () => {
    const sys = newShadows();
    const mesh = new THREE.Mesh();
    sys.registerCaster(mesh, () => casterMaterial());
    expect(sys.materials).toHaveLength(CASCADE_COUNT);
    expect(new Set(sys.materials).size).toBe(CASCADE_COUNT);
  });

  it("unregisterCaster removes the mesh from every cascade, leaving others intact", () => {
    const sys = newShadows();
    const keep = new THREE.Mesh();
    const drop = new THREE.Mesh();
    sys.registerCaster(keep, () => casterMaterial());
    sys.registerCaster(drop, () => casterMaterial());
    sys.unregisterCaster(drop);
    for (let c = 0; c < CASCADE_COUNT; c++) {
      expect(sys._casters[c].map(e => e.mesh)).toEqual([keep]);
    }
    // Unknown mesh is a harmless no-op.
    sys.unregisterCaster(new THREE.Mesh());
    for (let c = 0; c < CASCADE_COUNT; c++) {
      expect(sys._casters[c]).toHaveLength(1);
    }
  });

  it("update() points each registered material's lightViewProjection uniform at the cascade matrix", () => {
    const sys = newShadows();
    const mesh = new THREE.Mesh();
    const mats = [casterMaterial(), casterMaterial(), casterMaterial()];
    sys.registerCaster(mesh, (c) => mats[c]);
    sys.update(makeCamera(), SUN);
    for (let c = 0; c < CASCADE_COUNT; c++) {
      expect(mats[c].uniforms.lightViewProjection.value).toBe(sys.matrices[c]);
    }
  });
});
