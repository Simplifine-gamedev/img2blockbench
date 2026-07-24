# Three.js scene exporter

Executes an injected-Three.js factory and writes standard
`Object3D.toJSON()` output.

Factories export a default function:

```js
export default function createModel(THREE) {
  const root = new THREE.Group();
  // Add procedural geometry.
  return root;
}
```

Run:

```bash
npm install
npm run export -- /absolute/path/factory.mjs /absolute/path/scene.json
```
