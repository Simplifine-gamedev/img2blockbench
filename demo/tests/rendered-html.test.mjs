import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the img2blockbench demo", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>img2blockbench/);
  assert.match(html, /SAME IMAGE · THREE ROUTES · BBMODEL OUTPUT/);
  assert.match(html, /Platypus/);
  assert.match(html, /Trellis/);
  assert.match(html, /Three\.js/);
  assert.match(html, /Direct/);
  assert.match(html, /WHEEL/);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /<button/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("switches models client-side without replaying the artificial build", async () => {
  const source = await readFile(
    new URL("components/demo-shell.tsx", templateRoot),
    "utf8",
  );

  assert.match(source, /window\.history\.replaceState/);
  assert.match(source, /animalOrder\.forEach\(prefetchAnimal\)/);
  assert.match(source, /laneOrder\.map/);
  assert.doesNotMatch(source, /href=\{`\/\$\{slug\}`\}/);
  assert.doesNotMatch(source, /2_300/);
});

test("ships every reference and all three BBModel outputs", async () => {
  for (const animal of [
    "platypus",
    "chimpanzee",
    "elephant",
    "tiger",
    "coyote",
  ]) {
    for (const lane of ["lane1", "lane2", "lane3"]) {
      const model = await readFile(
        new URL(`public/models/${animal}-${lane}.bbmodel`, templateRoot),
        "utf8",
      );
      const parsed = JSON.parse(model);
      assert.ok(parsed.elements.length >= 15);
      assert.ok(parsed.textures[0].source.startsWith("data:image/png;base64,"));
      assert.equal(
        parsed.img2blockbench.front_axis,
        lane === "lane2" ? "negative_z" : "positive_z",
      );
      assert.equal(parsed.img2blockbench.texture_density, 2);
    }

    const image = await readFile(
      new URL(`public/references/${animal}.png`, templateRoot),
    );
    assert.ok(image.byteLength > 100_000);
  }
});

test("ships every official img2threejs Lane 3 intermediate", async () => {
  const expectedGeometry = {
    platypus: 28,
    chimpanzee: 22,
    elephant: 21,
    tiger: 20,
    coyote: 20,
  };

  for (const [animal, geometryCount] of Object.entries(expectedGeometry)) {
    const scene = JSON.parse(
      await readFile(
        new URL(`public/models/${animal}-lane3.three.json`, templateRoot),
        "utf8",
      ),
    );
    assert.equal(
      scene.object.userData.img2threejs.generator,
      "forge/stage3_build/generate_threejs_factory.py",
    );
    assert.equal(
      scene.object.userData.img2threejs.generatedPass,
      "optimization-pass",
    );
    assert.equal(
      scene.object.userData.img2threejs.commit,
      "f1ade81d45252ede20323d74a5b269c819f75245",
    );
    assert.equal(
      scene.object.userData.img2threejs.repository,
      "https://github.com/img2threejs/img2threejs",
    );
    // The official final pass adds one InstancedMesh repetition helper. The
    // box adapter intentionally compiles only the named component meshes.
    assert.equal(scene.geometries.length, geometryCount + 1);
    assert.ok(
      scene.materials.every(
        (material) => material.type === "MeshPhysicalMaterial",
      ),
    );
  }
});

test("Lane 3 keeps flat identity details in textures", async () => {
  const forbidden = /(?:^|_)(?:eye|glint|nostril|brow|stripe)(?:_|$)/;

  for (const animal of [
    "platypus",
    "chimpanzee",
    "elephant",
    "tiger",
    "coyote",
  ]) {
    const model = JSON.parse(
      await readFile(
        new URL(`public/models/${animal}-lane3.bbmodel`, templateRoot),
        "utf8",
      ),
    );
    assert.ok(model.elements.every((element) => !forbidden.test(element.name)));
    assert.equal(model.img2blockbench.front_axis, "positive_z");
    assert.ok(
      model.img2blockbench.texture_density === 2
        && model.resolution.width === 256
        && model.resolution.height === 256,
    );
  }
});
