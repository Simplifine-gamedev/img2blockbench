import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as THREE from "three";

const [factoryPath, outputPath] = process.argv.slice(2);

if (!factoryPath || !outputPath) {
  console.error("Usage: npm run export -- FACTORY.mjs OUTPUT.json");
  process.exit(2);
}

const factoryModule = await import(pathToFileURL(resolve(factoryPath)).href);
const factory =
  factoryModule.default ??
  factoryModule.createModel ??
  factoryModule.createObjectModel;

if (typeof factory !== "function") {
  throw new Error("Factory must export a default function or createModel()");
}

const root = await factory(THREE);
if (!(root instanceof THREE.Group)) {
  throw new Error("Factory must return a THREE.Group");
}

root.updateMatrixWorld(true);
const scene = root.toJSON();
const geometryIds = new Map();
const materialIds = new Map();

for (const [index, geometry] of (scene.geometries ?? []).entries()) {
  geometryIds.set(geometry.uuid, `geometry-${String(index + 1).padStart(3, "0")}`);
  geometry.uuid = geometryIds.get(geometry.uuid);
}

for (const [index, material] of (scene.materials ?? []).entries()) {
  materialIds.set(material.uuid, `material-${String(index + 1).padStart(3, "0")}`);
  material.uuid = materialIds.get(material.uuid);
}

let objectIndex = 0;
function canonicalizeObject(object) {
  objectIndex += 1;
  object.uuid = `object-${String(objectIndex).padStart(3, "0")}`;
  if (object.geometry) object.geometry = geometryIds.get(object.geometry);
  if (Array.isArray(object.material)) {
    object.material = object.material.map((id) => materialIds.get(id));
  } else if (object.material) {
    object.material = materialIds.get(object.material);
  }
  for (const child of object.children ?? []) canonicalizeObject(child);
}
canonicalizeObject(scene.object);

const output = resolve(outputPath);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(scene, null, 2)}\n`, "utf8");
console.log(output);
