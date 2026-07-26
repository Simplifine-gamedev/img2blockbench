# Lane 3: Three.js to Blockbench

This lane runs the official
[`hoainho/img2threejs`](https://github.com/hoainho/img2threejs) code generator,
uses its procedural Three.js scene as the intermediate, then converts its box
geometry and generated base-color maps into a native Blockbench model.

```text
Minecraft-style image
  → official img2threejs ObjectSculptSpec
  → official generated TypeScript THREE.Group factory
  → Object3D.toJSON scene
  → img2blockbench box geometry adapter
  → MeshPhysicalMaterial base-color map transfer
  → shared nearest-neighbor texture atlas
  → .bbmodel
```

The benchmark pins upstream commit
`c9077d5ecce834f6802d6742b4a5b2c682d6279d`. The upstream project is licensed
under Apache-2.0; its license is preserved in
[`UPSTREAM_LICENSE`](UPSTREAM_LICENSE). The generated factory is preserved unmodified as
[`createMinecraftPlatypusModel.generated.ts`](createMinecraftPlatypusModel.generated.ts).

## Artifacts

- [`img2threejs-spec.json`](img2threejs-spec.json): strict-quality
  `ObjectSculptSpec`, authored from the platypus reference.
- [`createMinecraftPlatypusModel.generated.ts`](createMinecraftPlatypusModel.generated.ts):
  output from the official generator.
- [`platypus.img2threejs.three.json`](platypus.img2threejs.three.json):
  browser-executed `Object3D.toJSON` result, including procedural materials.
- [`model-spec.json`](model-spec.json): box-compatible scene adapted into the
  shared Minecraft model contract with imported img2threejs material maps.
- [`projection-audit.json`](projection-audit.json): direct base-color transfer
  audit retained under its historical filename.
- [`blockbench/platypus-lane3.bbmodel`](blockbench/platypus-lane3.bbmodel):
  converted native Blockbench model with img2threejs albedo baked into its
  embedded atlas.
- [`blockbench/platypus-lane3.skill-audit.json`](blockbench/platypus-lane3.skill-audit.json):
  structural and UV-density audit.

## Reproduction

Clone the pinned upstream repository, then run its intake and starter-spec
commands:

```bash
git clone https://github.com/hoainho/img2threejs.git /tmp/img2threejs
git -C /tmp/img2threejs checkout c9077d5ecce834f6802d6742b4a5b2c682d6279d

python3 /tmp/img2threejs/forge/stage2_spec/new_pre_spec_assessment.py \
  "Minecraft Platypus" \
  --image examples/platypus/reference.png \
  --complexity complex \
  --out /tmp/platypus-assessment.json

python3 /tmp/img2threejs/forge/stage2_spec/new_sculpt_spec.py \
  "Minecraft Platypus" \
  --image examples/platypus/reference.png \
  --assessment /tmp/platypus-assessment.json \
  --out /tmp/platypus-starter-spec.json

python3 tools/img2threejs/prepare-platypus-spec.py \
  /tmp/platypus-starter-spec.json \
  --output examples/platypus/lane3/img2threejs-spec.json

python3 /tmp/img2threejs/forge/stage2_spec/validate_sculpt_spec.py \
  examples/platypus/lane3/img2threejs-spec.json \
  --strict-quality

python3 /tmp/img2threejs/forge/stage3_build/generate_threejs_factory.py \
  examples/platypus/lane3/img2threejs-spec.json \
  --out examples/platypus/lane3/createMinecraftPlatypusModel.generated.ts
```

Repeat generation and visual review through `optimization-pass`. The browser
exporter runs the final factory because img2threejs procedural materials use
browser canvas textures. The resulting scene is then converted with those maps
preserved:

```bash
img2blockbench from-threejs \
  examples/platypus/lane3/platypus.img2threejs.three.json \
  --reference examples/platypus/reference.png \
  --id platypus-lane3 \
  --description "Official img2threejs procedural platypus converted to native Minecraft cuboids" \
  --output /tmp/platypus-imported.json

pip install -e '.[reference-projection]'
python3 tools/img2threejs/bake-reference-faces.py \
  /tmp/platypus-imported.json \
  --reference examples/platypus/reference.png \
  --output-spec examples/platypus/lane3/model-spec.json \
  --audit examples/platypus/lane3/projection-audit.json

img2blockbench build \
  examples/platypus/lane3/model-spec.json \
  --output examples/platypus/lane3/blockbench
```

## Scope

This proof deliberately constrains img2threejs to `BoxGeometry`, so the adapter
can preserve dimensions and rotations without approximating spheres or triangle
meshes. It validates the cheaper procedural route, not the full multi-pass
visual-correction cost.
