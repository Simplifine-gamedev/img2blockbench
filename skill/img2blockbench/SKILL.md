---
name: img2blockbench
description: Reconstruct a Minecraft-style creature, character, prop, or vehicle concept as a native Blockbench model using an optional provider-selected 3D mesh, agent vision, and deterministic compilation. Use when Codex should turn PNG, JPEG, or WebP artwork, optionally accompanied by a textured GLB or GLTF from any image-to-3D generator, into an anatomy-driven `.bbmodel`, pixel texture atlas, Bedrock `geo.json`, bones, pivots, collision metadata, and audit bundle.
---

# img2blockbench

Build Minecraft geometry from a reference image, optionally using a
provider-selected source mesh as measured shape and texture evidence. Treat the
agent as the 3D reasoner and the bundled compiler as the file-format authority.

## Route selection

- Prefer Route 1 when a source mesh is supplied or organic depth is ambiguous.
  Accept a textured GLB or GLTF from any generator; do not require Trellis.
- Prefer Route 2 when the image already has clear Minecraft-native cuboid
  anatomy and no source mesh is needed.
- Use Route 3 only for an official img2threejs procedural scene.

For Route 1, record the generator name, model/version, source hash, and
applicable license in provenance. The generator is user-selected and remains
outside the deterministic compiler.

## Required references

- Read [references/model-spec.md](references/model-spec.md) before authoring or
  correcting a model specification.
- Read [references/quality-rubric.md](references/quality-rubric.md) before
  approving geometry, textures, rigging, or final output.

## Workflow

1. Resolve the repository root containing `pyproject.toml`. Install it once with
   `pip install -e .` when the `img2blockbench` command is unavailable.
2. Run `img2blockbench probe IMAGE --output WORKSPACE/reference.json`.
3. Inspect the image directly. Require Minecraft-native cuboid forms, crisp
   square-pixel materials, a full-body neutral pose, and separated appendages.
   If the source is a photo or smooth illustration, stop and create or request
   a Minecraft-style concept before continuing. Record subject type, pose,
   proportions, palette, identity features, hidden-side uncertainty, and
   intended Minecraft runtime.
4. Run `img2blockbench new IMAGE --id MODEL_ID --output WORKSPACE/model-spec.json`.
5. Replace the starter body with an anatomy-driven model specification. Prefer
   15–35 cuboids for a medium mob. Use fewer only when the subject is genuinely
   simple.
6. Run `img2blockbench validate WORKSPACE/model-spec.json --strict`.
7. Run `img2blockbench preview-threejs WORKSPACE/model-spec.json --output
   WORKSPACE/createModel.ts`. Render the procedural group beside the reference
   and correct silhouette, proportions, attachments, and identity features.
   This is a Route 2 preview generated from the cuboid spec, not a
   Three.js-first Route 3 source.
8. Run `img2blockbench build WORKSPACE/model-spec.json --output WORKSPACE/build`
   only after the shared cuboid scene passes the Three.js geometry review.
9. Open the emitted `.bbmodel` in Blockbench when available. Capture left,
   right, front, back, and isometric views plus bilateral head close-ups.
10. Correct the specification, rebuild, and re-render until the quality rubric
   passes. Do not patch generated `.bbmodel` JSON by hand.
11. Deliver the bundle ZIP and its individual `.bbmodel`, PNG, `geo.json`,
    audit, and manifest files.

## Modeling rules

- Use one rotated cuboid per anatomical segment whenever possible.
- Keep paired anatomy symmetric unless the image clearly requires asymmetry.
- Put pivots at shared joints. Overlap adjacent segments slightly.
- Use texture pixels for eyes, nostrils, markings, seams, and flat details.
- Never split geometry because a color changes.
- Never build dense voxel soup.
- Keep one texel density across the model.
- Infer unseen surfaces conservatively. Request another view when identity
  depends on hidden geometry.
- Treat static-model and animation approval as separate decisions.

## Direct Route 2 boundary

Do not call Meshy, Modly, Trellis, Tripo, Hunyuan, or another image-to-mesh
provider in this route. If a textured GLB or GLTF is intentionally supplied,
use Route 1 instead.

## Compiler boundary

The compiler validates and deterministically emits model files. It does not
invent anatomy or judge resemblance. The agent must author the bones, cuboids,
materials, face overrides, landmarks, uncertainties, and review targets.

Never claim success from a clean audit alone. Inspect real renders.
