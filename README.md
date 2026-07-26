# img2blockbench

Turn one Minecraft-style reference image into a native Blockbench model using
agent vision, optional mesh guidance, and deterministic compilation.

img2blockbench is Orca's open-source image-to-Blockbench benchmark and
compiler. Use it directly, or explore Orca's broader Minecraft creation tools
through the [Orca CLI](https://orcaclient.com/minecraft-cli),
[Orca MCP](https://orcaclient.com/minecraft-mcp), and
[orcaclient.com](https://orcaclient.com).

```text
Route 1: image → provider-selected 3D mesh → cuboid reconstruction → .bbmodel
Route 2: image → cuboid + texture reasoning → density-locked .bbmodel
Route 3: image → img2threejs scene → semantic texture pass → .bbmodel
```

### Route 1: mesh-guided

![Five Minecraft-style references above their mesh-guided Blockbench reconstructions](examples/five-animals-lane2.png)

### Route 2: direct

![Five Minecraft-style references above their direct Blockbench reconstructions](examples/five-animals-lane1.png)

### Route 3: img2threejs

![Five Minecraft-style references above their img2threejs-assisted Blockbench reconstructions](examples/five-animals-lane3.png)

## Interactive recording demo

The [`demo`](demo) app shows all three interactive `.bbmodel` outputs together.
Choose an animal once, then compare mesh-guided, Direct, and img2threejs routes
side by side. All 15 models are prefetched; drag to rotate, scroll to zoom,
and double-click to reset.

```bash
cd demo
npm install
npm run dev
```

## Five-animal conversion test

Every cell below is a deterministic render of the linked `.bbmodel`. Route 1
also retains its benchmark source mesh, anatomy specification, and eight-view
QA. Route 3 retains the official generated TypeScript factory and executable
Three.js scene.

<table>
  <thead>
    <tr>
      <th>Animal</th>
      <th>Minecraft-style reference</th>
      <th>Route 1 · Mesh-guided</th>
      <th>Route 2 · Direct</th>
      <th>Route 3 · img2threejs</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Platypus</strong></td>
      <td><img src="examples/platypus/reference.png" width="190" alt="Minecraft-style platypus reference"></td>
      <td><img src="examples/platypus/lane2/render.png" width="190" alt="Mesh-guided platypus Blockbench model"><br><a href="examples/platypus/lane2/platypus.bbmodel">22-cuboid .bbmodel</a> · <a href="examples/platypus/lane2/source.glb">GLB</a></td>
      <td><img src="examples/platypus/lane1/render.png" width="190" alt="Direct platypus Blockbench model"><br><a href="examples/platypus/lane1/platypus.bbmodel">16-cuboid .bbmodel</a></td>
      <td><img src="examples/platypus/lane3/render.png" width="190" alt="img2threejs platypus Blockbench model"><br><a href="examples/platypus/lane3/blockbench/platypus-lane3.bbmodel">28-cuboid .bbmodel</a> · <a href="examples/platypus/lane3/platypus.img2threejs.three.json">scene</a></td>
    </tr>
    <tr>
      <td><strong>Chimpanzee</strong></td>
      <td><img src="examples/chimpanzee/reference.png" width="190" alt="Minecraft-style chimpanzee reference"></td>
      <td><img src="examples/chimpanzee/lane2/render.png" width="190" alt="Mesh-guided chimpanzee Blockbench model"><br><a href="examples/chimpanzee/lane2/chimpanzee.bbmodel">24-cuboid .bbmodel</a> · <a href="examples/chimpanzee/lane2/source.glb">GLB</a></td>
      <td><img src="examples/chimpanzee/lane1/render.png" width="190" alt="Direct chimpanzee Blockbench model"><br><a href="examples/chimpanzee/lane1/chimpanzee.bbmodel">22-cuboid .bbmodel</a></td>
      <td><img src="examples/chimpanzee/lane3/render.png" width="190" alt="img2threejs chimpanzee Blockbench model"><br><a href="examples/chimpanzee/lane3/blockbench/chimpanzee-lane3.bbmodel">22-cuboid .bbmodel</a> · <a href="examples/chimpanzee/lane3/chimpanzee.img2threejs.three.json">scene</a></td>
    </tr>
    <tr>
      <td><strong>Elephant</strong></td>
      <td><img src="examples/elephant/reference.png" width="190" alt="Minecraft-style elephant reference"></td>
      <td><img src="examples/elephant/lane2/render.png" width="190" alt="Mesh-guided elephant Blockbench model"><br><a href="examples/elephant/lane2/elephant.bbmodel">24-cuboid .bbmodel</a> · <a href="examples/elephant/lane2/source.glb">GLB</a></td>
      <td><img src="examples/elephant/lane1/render.png" width="190" alt="Direct elephant Blockbench model"><br><a href="examples/elephant/lane1/elephant.bbmodel">21-cuboid .bbmodel</a></td>
      <td><img src="examples/elephant/lane3/render.png" width="190" alt="img2threejs elephant Blockbench model"><br><a href="examples/elephant/lane3/blockbench/elephant-lane3.bbmodel">21-cuboid .bbmodel</a> · <a href="examples/elephant/lane3/elephant.img2threejs.three.json">scene</a></td>
    </tr>
    <tr>
      <td><strong>Tiger</strong></td>
      <td><img src="examples/tiger/reference.png" width="190" alt="Minecraft-style tiger reference"></td>
      <td><img src="examples/tiger/lane2/render.png" width="190" alt="Mesh-guided tiger Blockbench model"><br><a href="examples/tiger/lane2/tiger.bbmodel">23-cuboid .bbmodel</a> · <a href="examples/tiger/lane2/source.glb">GLB</a></td>
      <td><img src="examples/tiger/lane1/render.png" width="190" alt="Direct tiger Blockbench model"><br><a href="examples/tiger/lane1/tiger.bbmodel">20-cuboid .bbmodel</a></td>
      <td><img src="examples/tiger/lane3/render.png" width="190" alt="img2threejs tiger Blockbench model"><br><a href="examples/tiger/lane3/blockbench/tiger-lane3.bbmodel">20-cuboid .bbmodel</a> · <a href="examples/tiger/lane3/tiger.img2threejs.three.json">scene</a></td>
    </tr>
    <tr>
      <td><strong>Coyote</strong></td>
      <td><img src="examples/coyote/reference.png" width="190" alt="Minecraft-style coyote reference"></td>
      <td><img src="examples/coyote/lane2/render.png" width="190" alt="Mesh-guided coyote Blockbench model"><br><a href="examples/coyote/lane2/coyote.bbmodel">23-cuboid .bbmodel</a> · <a href="examples/coyote/lane2/source.glb">GLB</a></td>
      <td><img src="examples/coyote/lane1/render.png" width="190" alt="Direct coyote Blockbench model"><br><a href="examples/coyote/lane1/coyote.bbmodel">20-cuboid .bbmodel</a></td>
      <td><img src="examples/coyote/lane3/render.png" width="190" alt="img2threejs coyote Blockbench model"><br><a href="examples/coyote/lane3/blockbench/coyote-lane3.bbmodel">20-cuboid .bbmodel</a> · <a href="examples/coyote/lane3/coyote.img2threejs.three.json">scene</a></td>
    </tr>
  </tbody>
</table>

Every output includes its embedded texture and a structural audit. Route 1 also
preserves the source GLB and records its source-palette facial repair. Route 3
preserves the procedural scene, clustered albedo audit, semantic texture
landmarks, and provenance.

The reusable image prompts are recorded in
[`examples/lane1-five-animals-prompts.md`](examples/lane1-five-animals-prompts.md).

Routes 2 and 3 require no neural image-to-3D mesh. Route 1 uses the mesh as
measured shape and texture evidence, then rebuilds it as native Minecraft
cuboids. The compiler handles file structure, UV packing, texture transfer,
auditing, Bedrock geometry, and reproducible manifests.

## Route 1: provider-agnostic mesh guidance

Route 1 does not require or call a particular image-to-3D service. The user
chooses the generator and supplies its exported mesh. The included benchmark
uses Trellis, but Trellis is an example provider rather than a dependency or
default.

The provider boundary is intentionally small:

- accept a textured `.glb` or `.gltf` containing one or more triangle meshes;
- prefer UVs and a base-color texture, but retain geometry when textures are
  unavailable;
- normalize the source with the anatomy spec's `canonical_transform`;
- record the provider, model/version, source hash, and applicable license in
  provenance; and
- reconstruct and validate native cuboids independently of the source
  generator.

This lets contributors use hosted, local, commercial, or open-source 3D
generators without changing the Blockbench compiler.

## Route 3: Three.js to Blockbench

Route 3 runs the official
[`img2threejs/img2threejs`](https://github.com/img2threejs/img2threejs) generator:

Its explicit implementation dependencies are:

- [`img2threejs`](https://github.com/img2threejs/img2threejs), pinned to commit
  `f1ade81d45252ede20323d74a5b269c819f75245`, for procedural TypeScript scene
  generation;
- [`Three.js`](https://threejs.org/) `0.185.1` for executing, serializing, and
  rendering the generated `Object3D`; and
- this repository's `img2blockbench` adapter for converting compatible
  `BoxGeometry` and native material maps into a textured `.bbmodel`.

```text
Minecraft-style image
  → strict-quality ObjectSculptSpec
  → official img2threejs TypeScript factory
  → browser-executed THREE.Group
  → visible Object3D scene
  → box geometry adapter
  → native material map and UV-transform transfer
  → texture-only semantic landmarks
  → nearest-neighbor Blockbench atlas
  → .bbmodel
```

The five-animal benchmark pins upstream commit
`f1ade81d45252ede20323d74a5b269c819f75245` and preserves the
spec, generated source, scene JSON, provenance, and converted model for every
animal. Eyes, nostrils, inner ears, and markings are declared texture-only
before factory generation, rather than surviving as decorative boxes. Each
remaining source component uses boxes, so dimensions and rotations transfer
directly.
The five factories are generated at `optimization-pass` after the ordered
blockout, structural, form, material, surface, lighting, interaction, and
optimization reviews. The adapter preserves each generated
`MeshPhysicalMaterial.map` plus repeat, wrap, offset, rotation, and flip state
without recoloring or palette reduction. The adapter samples those native maps
into one nearest-neighbor atlas, then paints each eye on exactly one face pair.
This avoids texture crushing, projection smearing, and duplicate facial marks.

Three.js roughness, normal, and AO maps remain preview-only because
Blockbench's Minecraft texture format has no equivalent PBR channels.

### Geometry comparison

These scores compare the direct Route 2 and final Route 3 `.bbmodel` geometry
after uniform normalization. They do not measure texture similarity.

| Animal | Boxes R2/R3 | Shape IoU | Topology F1 | Box count | Dimensions | Rotations | Weighted |
|---|---:|---:|---:|---:|---:|---:|---:|
| Platypus | 16 / 28 | 67.0% | 96.0% | 57.1% | 85.6% | 99.9% | 78.3% |
| Chimpanzee | 22 / 22 | 83.5% | 92.1% | 100.0% | 96.2% | 99.7% | 91.9% |
| Elephant | 21 / 21 | 90.5% | 100.0% | 100.0% | 97.5% | 99.7% | 96.2% |
| Tiger | 20 / 20 | 80.5% | 95.8% | 100.0% | 93.5% | 99.2% | 90.9% |
| Coyote | 20 / 20 | 82.9% | 100.0% | 100.0% | 94.1% | 99.7% | 92.8% |

Run `cd demo && npm run benchmark:geometry` to reproduce the comparison.
Rotation scores are high because both baselines are predominantly axis-aligned.

### Quality gates

These measurements cover all five animals. A UV-density outlier is a face
whose texel density is outside the accepted range; a detail cuboid is geometry
misused for a flat eye, nostril, marking, or stripe.

| Metric | Route 1 · Mesh | Route 2 · Direct | Route 3 · img2threejs |
|---|---:|---:|---:|
| Average cuboids | 23.2 | 19.8 | 22.2 |
| UV-density outlier faces | 0 | 0 | 0 |
| Flat detail cuboids | 0 | 0 | 0 |
| Texture landmarks | 16 | 25 | 42 |
| Explicit front axis | Yes | Yes | Yes |

Run `python3 tools/benchmark-quality.py` to reproduce
[`examples/quality-benchmark.json`](examples/quality-benchmark.json).

## Why

General image-to-3D tools produce triangle meshes. Minecraft mobs need something
different:

- a small set of meaningful cuboids;
- connected, animatable bones and pivots;
- one consistent pixel-art texture atlas;
- collision metadata and Bedrock-compatible geometry;
- visible checks from both sides, not only a plausible front render.

## Input contract

Direct Route 2 intentionally starts with images that already look
Minecraft-native:
clear cuboid anatomy, crisp square-pixel materials, a full-body neutral pose,
and separated appendages.

A photograph or smooth character illustration is not a valid direct-route demo
input. Restyle it into a Minecraft concept first, or use Route 1 when organic
depth is the important signal.

## Install

```bash
git clone https://github.com/orca-gamedev/img2blockbench.git
cd img2blockbench
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Install the bundled skill for your agent:

```bash
# Codex
cp -R skill/img2blockbench ~/.codex/skills/

# Claude Code
cp -R skill/img2blockbench ~/.claude/skills/
```

Then attach a reference image and ask:

```text
Use $img2blockbench to rebuild this creature as a Minecraft Blockbench model.
```

The agent supplies the visual reasoning. This repository supplies its workflow,
model contract, deterministic compiler, and quality gates. It does not bundle
or require a particular LLM API.

## Deterministic commands

```bash
# Inspect the source image.
img2blockbench probe ./reference.png

# Create a starter spec for the agent to complete.
img2blockbench new ./reference.png --id red-panda --output ./red-panda.json

# Block shallow or malformed specifications.
img2blockbench validate ./red-panda.json --strict

# Compile the accepted spec.
img2blockbench build ./red-panda.json --output ./dist

# Optional Route 2 preview generated from the cuboid spec.
img2blockbench preview-threejs \
  ./red-panda.json \
  --output ./createRedPandaModel.ts

# Route 3: import standard Three.js Object3D.toJSON output.
img2blockbench from-threejs \
  ./red-panda.three.json \
  --reference ./reference.png \
  --id red-panda-threejs \
  --description "A Minecraft-style red panda" \
  --output ./red-panda-threejs.json

# Preserve and audit the native img2threejs base-color maps.
pip install -e '.[reference-projection]'
python tools/img2threejs/bake-reference-faces.py \
  ./red-panda-threejs.json \
  --reference ./reference.png \
  --output-spec ./red-panda-imported.json \
  --audit ./red-panda-texture-transfer-audit.json

# After defining a red-panda entry in semantic-recipes.json, remove
# texture-only detail geometry and paint its landmarks.
python tools/img2threejs/semanticize-model-spec.py \
  ./red-panda-imported.json \
  --animal red-panda \
  --recipes ./tools/img2threejs/semantic-recipes.json \
  --reference ./reference.png \
  --output ./red-panda-textured.json

# Re-audit an existing Blockbench file.
img2blockbench audit ./dist/red-panda.bbmodel
```

The build directory contains:

```text
red-panda.bbmodel
red-panda.png
red-panda.geo.json
red-panda.model-spec.json
red-panda.reference.png
red-panda.audit.json
red-panda.manifest.json
red-panda.zip
```

See the original fox example in [`examples/fox`](examples/fox).

## Three-route architecture

All three routes converge on the same validated Minecraft model specification
and delivery bundle, but their upstream reasoning is separate.

| | Route 1 | Route 2 | Route 3 |
|---|---|---|---|
| Route | Image → selected 3D generator → cuboid spec | Image → cuboid spec | Image → img2threejs → cuboid spec |
| Intermediate | Textured GLB or GLTF | Native cuboid JSON | Generated TypeScript + Object3D JSON |
| External 3D GPU | Provider-dependent | None | None |
| Best fit | Ambiguous organic depth | Minecraft-native references | Cheaper procedural 3D reconstruction |
| Platypus cuboids | 22 | 16 | 28 |
| Shared output | `.bbmodel`, texture, `geo.json`, audit, bundle | Same | Same |

Route 2 may optionally render its cuboid spec through Three.js for review. That
preview does not make it Route 3. Route 3 begins with the official img2threejs
spec and generated Three.js scene, then ends as a native `.bbmodel`.

The repository retains its original `lane1` and `lane2` artifact paths so
existing links remain valid. The demo and documentation define their public
route order independently.

The current [platypus benchmark](examples/platypus/benchmark.json) records
artifact sizes, hashes, cuboid counts, bone counts, and external GPU
requirements. Generation latency, provider price, and LLM token usage were not
captured for the existing runs, so the repository does not fabricate those
cost numbers.

## Measured source-mesh overlap

The benchmark meshes below were generated with Trellis. The provider-neutral
audit rasterizes any supported source mesh and the reconstructed cuboids as
front, side, top, and isometric silhouettes, then records
intersection-over-union (IoU), source coverage, and model precision.

| Model | Mean IoU | Source coverage | Evidence |
|---|---:|---:|---|
| Platypus | 0.608 | 0.916 | [audit](examples/platypus/lane2/overlap-audit.json) · [sheet](examples/platypus/lane2/overlap-sheet.png) |
| Chimpanzee | 0.617 | 0.854 | [audit](examples/chimpanzee/lane2/overlap-audit.json) · [sheet](examples/chimpanzee/lane2/overlap-sheet.png) |
| Elephant | 0.675 | 0.947 | [audit](examples/elephant/lane2/overlap-audit.json) · [sheet](examples/elephant/lane2/overlap-sheet.png) |
| Tiger | 0.650 | 0.815 | [audit](examples/tiger/lane2/overlap-audit.json) · [sheet](examples/tiger/lane2/overlap-sheet.png) |
| Coyote | 0.570 | 0.883 | [audit](examples/coyote/lane2/overlap-audit.json) · [sheet](examples/coyote/lane2/overlap-sheet.png) |

White pixels are overlap, cyan is source-only, and orange is cuboid-only.
These results prove the source meshes are genuinely used, but also show that
the current reconstruction is approximate rather than an optimized silhouette
fit.

```bash
pip install -e '.[overlap-audit]'
img2blockbench-overlap \
  --source ./source.glb \
  --spec ./anatomy-spec.json \
  --bbmodel ./model.bbmodel \
  --json ./overlap-audit.json \
  --sheet ./overlap-sheet.png
```

## Honest limits

A single image cannot reveal every hidden surface or guarantee exact depth.
The workflow records uncertainty, mirrors bilateral anatomy when appropriate,
and requires multi-view Blockbench review. It should request another view
instead of pretending ambiguous anatomy is known.

## Development

```bash
pip install -e .
python -m unittest discover -s tests -v
python skill/img2blockbench/scripts/img2blockbench.py validate \
  examples/fox/model-spec.json --strict
```

MIT licensed.
