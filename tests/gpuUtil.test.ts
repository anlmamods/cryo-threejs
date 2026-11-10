import { describe, it, expect, beforeAll, vi } from "vitest";
import * as THREE from "three";
import { makeMaterial, FullscreenPass, whenReady } from "../src/core/gpuUtil.js";
import { registerShaders } from "../src/shaders/registry.js";

beforeAll(() => {
  registerShaders();
});

const VERT = "void main() { gl_Position = vec4(0.0); }";
const FRAG = "void main() { gl_FragColor = vec4(1.0); }";

describe("makeMaterial", () => {
  it("builds a GLSL3 RawShaderMaterial", () => {
    const mat = makeMaterial({ vertex: VERT, fragment: FRAG });
    expect(mat).toBeInstanceOf(THREE.RawShaderMaterial);
    expect(mat.glslVersion).toBe(THREE.GLSL3);
  });

  it("name falls back to \"\" and is honoured when given", () => {
    expect(makeMaterial({ vertex: VERT, fragment: FRAG }).name).toBe("");
    expect(makeMaterial({ name: "snow-thing", vertex: VERT, fragment: FRAG }).name).toBe("snow-thing");
  });

  it("resolves #include chunks in both stages via the registry", () => {
    const mat = makeMaterial({
      vertex: "#include<snowNoise>\nvoid main() { gl_Position = vec4(0.0); }",
      fragment: "#include<snowNoise>\nvoid main() { gl_FragColor = vec4(1.0); }",
    });
    expect(mat.vertexShader).not.toContain("#include");
    expect(mat.fragmentShader).not.toContain("#include");
    expect(mat.vertexShader).toContain("void main()");
    expect(mat.fragmentShader).toContain("void main()");
  });

  it("unknown include throws through composeShader", () => {
    expect(() => makeMaterial({ vertex: "#include<nopeNotAChunk>\nvoid main(){}", fragment: FRAG })).toThrow();
  });

  it("material flags land on the material", () => {
    const mat = makeMaterial({ vertex: VERT, fragment: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.side).toBe(THREE.DoubleSide);
  });

  it("uniforms passed in are live on the material (value read-through)", () => {
    const uniforms = { time: { value: 1.5 }, tint: { value: new THREE.Vector3(1, 2, 3) } };
    const mat = makeMaterial({ vertex: VERT, fragment: FRAG, uniforms });
    expect(mat.uniforms.time.value).toBe(1.5);
    expect(mat.uniforms.tint.value).toEqual(new THREE.Vector3(1, 2, 3));
    // mutating through the material's uniform entry is what call sites do per-frame
    mat.uniforms.time.value = 2.5;
    expect(mat.uniforms.time.value).toBe(2.5);
  });

  it("materials made without uniforms do not share a uniforms object", () => {
    const a = makeMaterial({ vertex: VERT, fragment: FRAG });
    const b = makeMaterial({ vertex: VERT, fragment: FRAG });
    expect(a.uniforms).not.toBe(b.uniforms);
    expect(a.uniforms).toEqual({});
  });
});

describe("FullscreenPass", () => {
  const gfxStub = {} as never; // constructor stores it; nothing GL is touched

  it("constructs and exposes .material", () => {
    const pass = new FullscreenPass(gfxStub, { fragment: FRAG });
    expect(pass.material).toBeInstanceOf(THREE.RawShaderMaterial);
    expect(pass.material.glslVersion).toBe(THREE.GLSL3);
    expect(pass.material.depthTest).toBe(false);
    expect(pass.material.depthWrite).toBe(false);
  });

  it("name defaults to \"fullscreen\" and is honoured when given", () => {
    expect(new FullscreenPass(gfxStub, { fragment: FRAG }).name).toBe("fullscreen");
    const pass = new FullscreenPass(gfxStub, { name: "heightBake", fragment: FRAG });
    expect(pass.name).toBe("heightBake");
    expect(pass.material.name).toBe("heightBake");
  });

  it("fragment chunks are resolved at construction", () => {
    const pass = new FullscreenPass(gfxStub, { fragment: "#include<snowNoise>\nvoid main(){}" });
    expect(pass.material.fragmentShader).not.toContain("#include");
  });
});

describe("whenReady", () => {
  function gfxWithCompileAsync(impl?: () => Promise<unknown>) {
    const compileAsync = vi.fn(impl ?? (async () => ({})));
    const gfx = {
      renderer: { compileAsync },
      scene: new THREE.Scene(),
      threeCamera: new THREE.Camera(),
    };
    return { gfx: gfx as never, compileAsync };
  }

  it("resolves on the success path (FullscreenPass compiles via renderer.compileAsync)", async () => {
    const { gfx, compileAsync } = gfxWithCompileAsync();
    const pass = new FullscreenPass(gfx, { fragment: FRAG });
    await expect(whenReady(gfx, pass, "test-pass")).resolves.toBeUndefined();
    expect(compileAsync).toHaveBeenCalledTimes(1);
  });

  it("resolves on the success path (bare material)", async () => {
    const { gfx, compileAsync } = gfxWithCompileAsync();
    const mat = makeMaterial({ vertex: VERT, fragment: FRAG });
    await expect(whenReady(gfx, mat, "test-material")).resolves.toBeUndefined();
    expect(compileAsync).toHaveBeenCalledTimes(1);
  });

  it("resolves on the success path (wrapper carrying .material)", async () => {
    const { gfx, compileAsync } = gfxWithCompileAsync();
    const wrapper = { material: makeMaterial({ vertex: VERT, fragment: FRAG }) };
    await expect(whenReady(gfx, wrapper, "test-wrapper")).resolves.toBeUndefined();
    expect(compileAsync).toHaveBeenCalledTimes(1);
  });

  it("stub peer with nothing to compile resolves without throwing", async () => {
    const { gfx, compileAsync } = gfxWithCompileAsync();
    await expect(whenReady(gfx, {} as never, "test-stub-peer")).resolves.toBeUndefined();
    await expect(whenReady(gfx, null, "test-null-peer")).resolves.toBeUndefined();
    await expect(whenReady(gfx, undefined, "test-undefined-peer")).resolves.toBeUndefined();
    expect(compileAsync).not.toHaveBeenCalled();
  });

  it("drawFn is awaited instead of compiling when given", async () => {
    const { gfx, compileAsync } = gfxWithCompileAsync();
    const drawFn = vi.fn(async () => "drawn");
    await expect(whenReady(gfx, null, "test-drawfn", drawFn)).resolves.toBeUndefined();
    expect(drawFn).toHaveBeenCalledTimes(1);
    expect(compileAsync).not.toHaveBeenCalled();
  });
});
