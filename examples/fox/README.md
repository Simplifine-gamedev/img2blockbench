# Fox example

This example starts from the Minecraft-style [`reference.jpg`](reference.jpg),
generated from [`concept-prompt.txt`](concept-prompt.txt), then describes its
anatomy in [`model-spec.json`](model-spec.json).

```bash
img2blockbench probe examples/fox/reference.jpg
img2blockbench validate examples/fox/model-spec.json --strict
img2blockbench build examples/fox/model-spec.json --output examples/fox/build
```

The strict specification contains 17 cuboids and 17 semantic bones. The build
emits the editable Blockbench project, pixel atlas, Bedrock geometry, reference
provenance, audit, manifest, and deterministic bundle ZIP.
