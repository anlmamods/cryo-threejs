import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/core/assets.js", () => ({
  fetchAsset: vi.fn(),
  assetCandidates: (p: string) => [p],
  asset: (p: string) => p,
}));

import { fetchAsset } from "../src/core/assets.js";
import { loadModelAsset } from "../src/player/modelAsset.js";

const mockFetch = vi.mocked(fetchAsset);

const TYPE_CTOR = {
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Uint32Array,
  Float32Array,
} as const;
type TypeName = keyof typeof TYPE_CTOR;

interface SectionInput {
  name: string;
  type: TypeName;
  values: number[];
}

/** Smallest valid section set: one LOD, two vertices, one triangle, one bone. */
const defaultSections = (): SectionInput[] => [
  { name: "position0", type: "Int16Array", values: [-32768, 0, 32767, 100, 200, 300] },
  { name: "normal0", type: "Int8Array", values: [127, 0, -127, 64, -64, 127] },
  { name: "texcoord0", type: "Uint16Array", values: [0, 65535, 32768, 16384] },
  { name: "boneIdx0", type: "Uint8Array", values: [0, 1, 2, 3, 3, 2, 1, 0] },
  { name: "boneWt0", type: "Uint8Array", values: [255, 128, 0, 255, 0, 255, 128, 0] },
  { name: "slot0", type: "Uint8Array", values: [0, 3] },
  { name: "indices0", type: "Uint16Array", values: [0, 1, 0] },
  { name: "anim", type: "Int16Array", values: Array.from({ length: 24 }, (_, i) => i - 12) },
];

function buildSnwk(
  opts: {
    magic?: string;
    header?: Record<string, unknown>;
    sections?: SectionInput[];
    omitSections?: string[];
  } = {}
): ArrayBuffer {
  const sections = (opts.sections ?? defaultSections()).filter(
    (s) => !(opts.omitSections ?? []).includes(s.name)
  );
  /** Element width per section type — payload offsets must be element-aligned. */
  const TYPE_SIZE: Record<TypeName, number> = {
    Int8Array: 1, Uint8Array: 1, Int16Array: 2, Uint16Array: 2, Uint32Array: 4, Float32Array: 4,
  };
  let offset = 0;
  const layout: { name: string; offset: number; count: number; type: string }[] = [];
  const parts: { bytes: Uint8Array; at: number }[] = [];
  for (const s of sections) {
    const Ctor = TYPE_CTOR[s.type];
    const arr = new (Ctor as new (v: number[]) => Int16Array)(s.values);
    const bytes = new Uint8Array(arr.buffer.slice(0));
    offset = Math.ceil(offset / TYPE_SIZE[s.type]) * TYPE_SIZE[s.type];
    layout.push({ name: s.name, offset, count: s.values.length, type: s.type });
    parts.push({ bytes, at: offset });
    offset += bytes.byteLength;
  }
  const header = {
    version: 2,
    lods: [{ level: 0 }],
    posOffset: [1, 2, 3],
    posScale: [0.5, 0.25, 2],
    textureSize: 4,
    materials: [] as unknown[],
    boneCount: 1,
    frameCount: 2,
    duration: 1,
    ...opts.header,
    layout,
  };
  // Pad the JSON header with trailing spaces so the payload lands 4-byte
  // aligned — JSON.parse tolerates trailing whitespace. The typed-array
  // views in the loader require payload + section offset to be aligned.
  let headerJson = JSON.stringify(header);
  while ((8 + new TextEncoder().encode(headerJson).length) % 4 !== 0) headerJson += " ";
  const headerBytes = new TextEncoder().encode(headerJson);
  const buffer = new ArrayBuffer(8 + headerBytes.length + offset);
  const magic = opts.magic ?? "SNWK";
  const magicBytes = new Uint8Array(buffer, 0, 4);
  for (let i = 0; i < 4; i++) magicBytes[i] = magic.charCodeAt(i);
  new DataView(buffer).setUint32(4, headerBytes.length, true);
  new Uint8Array(buffer).set(headerBytes, 8);
  for (const p of parts) {
    new Uint8Array(buffer).set(p.bytes, 8 + headerBytes.length + p.at);
  }
  return buffer;
}

/** Known pixel payload the fake 2D context hands back from getImageData. */
const PIXEL_RGBA = 128;
function fakePixels(n: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i += 4) {
    px[i] = PIXEL_RGBA;
    px[i + 1] = PIXEL_RGBA;
    px[i + 2] = PIXEL_RGBA;
    px[i + 3] = 255;
  }
  return px;
}

const fakeCtx = {
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  getImageData: (_x: number, _y: number, w: number, h: number) => ({
    data: fakePixels(w * h),
  }),
};

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return fakeCtx;
  }
}

function mockBinOnly(buffer: ArrayBuffer) {
  mockFetch.mockImplementation(async (path: string) => {
    if (path.endsWith(".bin")) {
      return { arrayBuffer: async () => buffer } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadModelAsset — SNWK container validation", () => {
  it("throws on bad magic", async () => {
    mockBinOnly(buildSnwk({ magic: "XXXX" }));
    await expect(loadModelAsset("m")).rejects.toThrow(/bad magic/);
  });

  it("throws on a non-v2 header version", async () => {
    mockBinOnly(buildSnwk({ header: { version: 3 } }));
    await expect(loadModelAsset("m")).rejects.toThrow(/unsupported version 3/);
  });

  it("throws when the header is not a v2-shaped header", async () => {
    // layout must be an array; hand-encode a header that is not.
    const headerBytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    const buffer = new ArrayBuffer(8 + headerBytes.length);
    new Uint8Array(buffer, 0, 4).set([0x53, 0x4e, 0x57, 0x4b]); // "SNWK"
    new DataView(buffer).setUint32(4, headerBytes.length, true);
    new Uint8Array(buffer).set(headerBytes, 8);
    mockBinOnly(buffer);
    await expect(loadModelAsset("m")).rejects.toThrow(/not a v2 header/);
  });

  it("throws naming the missing section", async () => {
    mockBinOnly(buildSnwk({ omitSections: ["position0"] }));
    await expect(loadModelAsset("m")).rejects.toThrow(/section "position0" missing/);
  });
});

describe("loadModelAsset — dequantisation", () => {
  it("widens positions with (q + 32768) * scale + offset per axis", async () => {
    mockBinOnly(buildSnwk());
    const asset = await loadModelAsset("m");
    const p = asset.lods[0].positions;
    expect(p[0]).toBe((-32768 + 32768) * 0.5 + 1);
    expect(p[1]).toBe((0 + 32768) * 0.25 + 2);
    expect(p[2]).toBe((32767 + 32768) * 2 + 3);
    expect(p[3]).toBe((100 + 32768) * 0.5 + 1);
    expect(p[4]).toBe((200 + 32768) * 0.25 + 2);
    expect(p[5]).toBe((300 + 32768) * 2 + 3);
  });

  it("widens normals with /127", async () => {
    mockBinOnly(buildSnwk());
    const asset = await loadModelAsset("m");
    const n = asset.lods[0].normals;
    expect(n[0]).toBeCloseTo(1, 6);
    expect(n[1]).toBe(0);
    expect(n[2]).toBeCloseTo(-1, 6);
    expect(n[3]).toBeCloseTo(64 / 127, 6);
    expect(n[4]).toBeCloseTo(-64 / 127, 6);
    expect(n[5]).toBeCloseTo(1, 6);
  });

  it("widens uvs with /65535", async () => {
    mockBinOnly(buildSnwk());
    const asset = await loadModelAsset("m");
    const uv = asset.lods[0].uvs;
    expect(uv[0]).toBe(0);
    expect(uv[1]).toBe(1);
    expect(uv[2]).toBeCloseTo(32768 / 65535, 6);
    expect(uv[3]).toBeCloseTo(16384 / 65535, 6);
  });

  it("widens bone weights with /255 and leaves bone indices raw", async () => {
    mockBinOnly(buildSnwk());
    const asset = await loadModelAsset("m");
    const wt = asset.lods[0].boneWt;
    const idx = asset.lods[0].boneIdx;
    expect(wt[0]).toBe(1);
    expect(wt[1]).toBeCloseTo(128 / 255, 6);
    expect(wt[2]).toBe(0);
    expect(wt[3]).toBe(1);
    expect(wt[4]).toBe(0);
    expect(wt[5]).toBe(1);
    expect(wt[6]).toBeCloseTo(128 / 255, 6);
    expect(wt[7]).toBe(0);
    expect([...idx]).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
  });

  it("reports vertex/triangle counts from the slot and index sections", async () => {
    mockBinOnly(buildSnwk());
    const asset = await loadModelAsset("m");
    const lod = asset.lods[0];
    expect(lod.vertexCount).toBe(2);
    expect(lod.triangleCount).toBe(1);
    expect(lod.indices.length).toBe(3);
    expect(lod.aux[0]).toBe(0);
    expect(lod.aux[2]).toBe(3);
  });
});

describe("loadModelAsset — clips", () => {
  it("slices extra clips out of the anim table when header.clips is present", async () => {
    mockBinOnly(
      buildSnwk({
        header: { clips: [{ name: "hit", frame0: 1, frameCount: 1, duration: 0.5 }] },
      })
    );
    const asset = await loadModelAsset("m");
    expect(asset.clips).not.toBeNull();
    const clip = asset.clips!["hit"];
    expect(clip.frameCount).toBe(1);
    expect(clip.duration).toBe(0.5);
    // stride = boneCount * 12 = 12; frame0=1 → subarray(12, 24)
    expect(clip.anim.length).toBe(12);
    expect(clip.anim[0]).toBe(0);
    expect(clip.anim[11]).toBe(11);
    // a view onto the same buffer, not a copy
    expect(clip.anim.buffer).toBe(asset.anim.buffer);
  });

  it("ignores clips entirely when header.clips is absent", async () => {
    mockBinOnly(buildSnwk());
    const asset = await loadModelAsset("m");
    expect(asset.clips).toBeNull();
  });
});

describe("loadModelAsset — texture layers", () => {
  it("floors the layer count at 4 when there are few materials", async () => {
    mockBinOnly(buildSnwk());
    const asset = await loadModelAsset("m");
    expect(asset.layers).toBe(4);
    expect(asset.albedoSize).toBe(4);
    expect(asset.ormSize).toBe(4);
  });

  it("grows the layer count past 4 to match the material count", async () => {
    const materials = Array.from({ length: 6 }, (_, i) => ({
      name: `m${i}`,
      slot: i,
      roughness: 0.5,
      metallic: 0,
      albedoImage: -1,
      ormImage: -1,
    }));
    mockBinOnly(buildSnwk({ header: { materials } }));
    const asset = await loadModelAsset("m");
    expect(asset.layers).toBe(6);
  });

  const texturedHeader = {
    materials: [
      { name: "hull", slot: 0, roughness: 0.5, metallic: 0.5, albedoImage: 0, ormImage: -1 },
    ],
  };

  function mockWithTextures(buffer: ArrayBuffer) {
    mockFetch.mockImplementation(async (path: string) => {
      if (path.endsWith(".bin")) {
        return { arrayBuffer: async () => buffer } as unknown as Response;
      }
      if (path.includes("_albedo_0.webp")) {
        return { blob: async () => new Blob([new Uint8Array([1, 2, 3])]) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
  }

  it("srgbAlbedo off keeps raw sRGB bytes", async () => {
    mockWithTextures(buildSnwk({ header: texturedHeader }));
    const asset = await loadModelAsset("m");
    expect(asset.albedo![0]).toBe(PIXEL_RGBA);
    expect(asset.albedo![1]).toBe(PIXEL_RGBA);
    expect(asset.albedo![2]).toBe(PIXEL_RGBA);
    expect(asset.albedo![3]).toBe(255);
  });

  it("srgbAlbedo on decodes RGB through the IEC 61966-2-1 curve and leaves alpha alone", async () => {
    mockWithTextures(buildSnwk({ header: texturedHeader }));
    const asset = await loadModelAsset("m", { srgbAlbedo: true });
    // 128/255 = 0.502 → ((c + 0.055) / 1.055)^2.4 ≈ 0.216 → round(0.216 * 255) = 55
    expect(asset.albedo![0]).toBe(55);
    expect(asset.albedo![0]).toBeLessThan(PIXEL_RGBA);
    expect(asset.albedo![1]).toBe(55);
    expect(asset.albedo![2]).toBe(55);
    expect(asset.albedo![3]).toBe(255); // alpha is coverage, untouched
    // the ORM array is never re-gamma'd, even with srgbAlbedo on
    expect(asset.orm![0]).toBe(255); // untouched white fill (ormImage = -1)
  });
});
