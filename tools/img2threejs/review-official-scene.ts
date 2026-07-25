import * as THREE from "three";
import * as platypus from "../../examples/platypus/lane3/createMinecraftPlatypusModel.generated";
import * as chimpanzee from "../../examples/chimpanzee/lane3/createMinecraftChimpanzeeModel.generated";
import * as elephant from "../../examples/elephant/lane3/createMinecraftElephantModel.generated";
import * as tiger from "../../examples/tiger/lane3/createMinecraftTigerModel.generated";
import * as coyote from "../../examples/coyote/lane3/createMinecraftCoyoteModel.generated";

type ModelModule = {
  create: (options?: Record<string, unknown>) => THREE.Group;
  lights: () => THREE.Group;
  environment: (renderer: THREE.WebGLRenderer) => THREE.Texture;
  frame: (
    camera: THREE.PerspectiveCamera,
    object: THREE.Object3D,
    options?: Record<string, unknown>,
  ) => void;
};

const factories: Record<string, ModelModule> = {
  platypus: {
    create: platypus.createMinecraftPlatypusModel,
    lights: platypus.createMinecraftPlatypusLookDevLights,
    environment: platypus.createMinecraftPlatypusEnvironment,
    frame: platypus.frameMinecraftPlatypusCamera,
  },
  chimpanzee: {
    create: chimpanzee.createMinecraftChimpanzeeModel,
    lights: chimpanzee.createMinecraftChimpanzeeLookDevLights,
    environment: chimpanzee.createMinecraftChimpanzeeEnvironment,
    frame: chimpanzee.frameMinecraftChimpanzeeCamera,
  },
  elephant: {
    create: elephant.createMinecraftElephantModel,
    lights: elephant.createMinecraftElephantLookDevLights,
    environment: elephant.createMinecraftElephantEnvironment,
    frame: elephant.frameMinecraftElephantCamera,
  },
  tiger: {
    create: tiger.createMinecraftTigerModel,
    lights: tiger.createMinecraftTigerLookDevLights,
    environment: tiger.createMinecraftTigerEnvironment,
    frame: tiger.frameMinecraftTigerCamera,
  },
  coyote: {
    create: coyote.createMinecraftCoyoteModel,
    lights: coyote.createMinecraftCoyoteLookDevLights,
    environment: coyote.createMinecraftCoyoteEnvironment,
    frame: coyote.frameMinecraftCoyoteCamera,
  },
};

const params = new URLSearchParams(window.location.search);
const animal = params.get("animal") ?? "platypus";
const factory = factories[animal];
if (!factory) throw new Error(`Unknown animal: ${animal}`);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#111820");
scene.environment = factory.environment(renderer);

const model = factory.create({
  castShadow: true,
  receiveShadow: true,
  textureSize: 256,
  textureAnisotropy: 4,
  qualityPriority: "reference-fidelity",
});
scene.add(model);
scene.add(factory.lights());

const bounds = new THREE.Box3().setFromObject(model);
const center = bounds.getCenter(new THREE.Vector3());
const size = bounds.getSize(new THREE.Vector3());
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(Math.max(size.x, size.z) * 4, Math.max(size.x, size.z) * 4),
  new THREE.MeshStandardMaterial({ color: "#202b35", roughness: 0.92 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = bounds.min.y - 0.04;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(
  Math.max(size.x, size.z) * 3.4,
  16,
  new THREE.Color("#334453"),
  new THREE.Color("#263541"),
);
grid.position.y = floor.position.y + 0.015;
scene.add(grid);

const camera = new THREE.PerspectiveCamera(
  34,
  window.innerWidth / window.innerHeight,
  0.01,
  2000,
);
factory.frame(camera, model, {
  margin: 1.22,
  azimuthDeg: 34,
  elevationDeg: 16,
});
camera.lookAt(center);

renderer.render(scene, camera);
requestAnimationFrame(() => {
  renderer.render(scene, camera);
  document.body.dataset.renderStatus = "ready";
});
