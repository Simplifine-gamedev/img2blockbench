"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Animal } from "@/lib/animals";

type FaceName = "east" | "west" | "up" | "down" | "south" | "north";

type BbFace = {
  texture: number | null;
  uv?: [number, number, number, number];
};

type BbElement = {
  type: "cube";
  from: [number, number, number];
  to: [number, number, number];
  origin?: [number, number, number];
  rotation?: [number, number, number];
  faces: Partial<Record<FaceName, BbFace>>;
};

type BbModel = {
  elements: BbElement[];
  resolution: { width: number; height: number };
  textures: Array<{ source: string }>;
};

const materialOrder: FaceName[] = [
  "east",
  "west",
  "up",
  "down",
  "south",
  "north",
];

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode model texture"));
    image.src = source;
  });
}

const faceShade: Record<FaceName, number> = {
  east: 0xf5f5f5,
  west: 0xe8e8e8,
  up: 0xffffff,
  down: 0xe2e2e2,
  south: 0xffffff,
  north: 0xeeeeee,
};

function faceMaterial(
  atlas: HTMLImageElement,
  face: BbFace | undefined,
  faceName: FaceName,
) {
  if (!face?.uv || face.texture === null) {
    return new THREE.MeshBasicMaterial({
      color: 0xa8b5be,
      transparent: true,
      opacity: 0,
      toneMapped: false,
    });
  }

  const [u1, v1, u2, v2] = face.uv;
  const sourceX = Math.min(u1, u2);
  const sourceY = Math.min(v1, v2);
  const sourceWidth = Math.max(1, Math.abs(u2 - u1));
  const sourceHeight = Math.max(1, Math.abs(v2 - v1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(sourceWidth));
  canvas.height = Math.max(1, Math.ceil(sourceHeight));
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create texture canvas");
  }

  context.imageSmoothingEnabled = false;
  context.save();
  context.translate(u2 < u1 ? canvas.width : 0, v2 < v1 ? canvas.height : 0);
  context.scale(u2 < u1 ? -1 : 1, v2 < v1 ? -1 : 1);
  context.drawImage(
    atlas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  context.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return new THREE.MeshBasicMaterial({
    map: texture,
    color: faceShade[faceName],
    transparent: true,
    opacity: 0,
    toneMapped: false,
  });
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) value.dispose();
      });
      material.dispose();
    });
  });
}

export function ModelViewer({
  animal,
  modelFile,
  format,
  ready,
  replayKey,
  captureMode,
  onLoaded,
}: {
  animal: Animal;
  modelFile: string;
  format: "bbmodel" | "threejs";
  ready: boolean;
  replayKey: number;
  captureMode: boolean;
  onLoaded: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<THREE.Object3D | null>(null);
  const materialsRef = useRef<THREE.Material[]>([]);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const revealFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 600);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (captureMode) renderer.setClearColor(0xf5f5f4, 1);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.enablePan = false;
    controls.autoRotate = !captureMode;
    controls.autoRotateSpeed = 0.65;
    controls.minDistance = 18;
    controls.maxDistance = 110;
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xd8efff, 0x15202a, 2.4));

    const keyLight = new THREE.DirectionalLight(0xffffff, 4.4);
    keyLight.position.set(-24, 38, -28);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(
      new THREE.Color(animal.accent),
      3.2,
    );
    rimLight.position.set(30, 16, 24);
    scene.add(rimLight);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(180, 180),
      new THREE.MeshStandardMaterial({
        color: captureMode ? 0xf5f5f4 : 0x071019,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: captureMode ? 1 : 0.64,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.08;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(
      132,
      44,
      captureMode ? 0xbac2c8 : 0x274255,
      captureMode ? 0xd8dde0 : 0x142532,
    );
    grid.position.y = 0.02;
    const gridMaterials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    gridMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.52;
    });
    scene.add(grid);

    let stopped = false;
    let animationFrame = 0;

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animate();

    const loadBbmodel = async () => {
      const response = await fetch(`/models/${modelFile}`);
      if (!response.ok) {
        throw new Error(`Could not load ${modelFile}`);
      }
      const model = (await response.json()) as BbModel;
      const atlas = await loadImage(model.textures[0].source);

      const modelRoot = new THREE.Group();
      const modelMaterials: THREE.Material[] = [];

      for (const element of model.elements) {
        if (element.type !== "cube") continue;

        const size = new THREE.Vector3(
          element.to[0] - element.from[0],
          element.to[1] - element.from[1],
          element.to[2] - element.from[2],
        );
        const center = new THREE.Vector3(
          (element.from[0] + element.to[0]) / 2,
          (element.from[1] + element.to[1]) / 2,
          (element.from[2] + element.to[2]) / 2,
        );
        const originValues = element.origin ?? [
          center.x,
          center.y,
          center.z,
        ];
        const origin = new THREE.Vector3(
          originValues[0],
          originValues[1],
          originValues[2],
        );
        const rotation = element.rotation ?? [0, 0, 0];
        const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
        const materials = materialOrder.map((faceName) =>
          faceMaterial(
            atlas,
            element.faces[faceName],
            faceName,
          ),
        );
        modelMaterials.push(...materials);

        const mesh = new THREE.Mesh(geometry, materials);
        mesh.position.copy(center).sub(origin);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        const pivot = new THREE.Group();
        pivot.position.copy(origin);
        pivot.rotation.order = "ZYX";
        pivot.rotation.set(
          THREE.MathUtils.degToRad(rotation[0]),
          THREE.MathUtils.degToRad(rotation[1]),
          THREE.MathUtils.degToRad(rotation[2]),
        );
        pivot.add(mesh);
        modelRoot.add(pivot);
      }

      return { modelRoot, modelMaterials };
    };

    const loadThreejsScene = async () => {
      const response = await fetch(`/models/${modelFile}`);
      if (!response.ok) {
        throw new Error(`Could not load ${modelFile}`);
      }
      const sceneJson = await response.json();
      const loader = new THREE.ObjectLoader();
      const modelRoot = await new Promise<THREE.Object3D>((resolve) => {
        loader.parse(sceneJson, resolve);
      });
      const modelMaterials: THREE.Material[] = [];

      modelRoot.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.castShadow = true;
        child.receiveShadow = true;
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        modelMaterials.push(...materials);
      });

      return { modelRoot, modelMaterials };
    };

    const buildModel = async () => {
      const { modelRoot, modelMaterials } =
        format === "threejs"
          ? await loadThreejsScene()
          : await loadBbmodel();

      if (stopped) {
        disposeObject(modelRoot);
        return;
      }

      const bounds = new THREE.Box3().setFromObject(modelRoot);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      modelRoot.position.set(-center.x, -bounds.min.y, -center.z);
      modelRoot.visible = captureMode;
      modelRoot.scale.setScalar(captureMode ? 1 : 0.82);
      if (captureMode) {
        modelMaterials.forEach((material) => {
          material.transparent = false;
          material.opacity = 1;
        });
      }

      rootRef.current = modelRoot;
      materialsRef.current = modelMaterials;
      scene.add(modelRoot);

      const span = Math.max(size.x, size.y, size.z);
      camera.position.set(
        span * (captureMode ? 1.35 : 1.15),
        span * (captureMode ? 0.86 : 0.72),
        span * (captureMode ? 2.05 : -1.38),
      );
      controls.target.set(0, size.y * (captureMode ? 0.5 : 0.42), 0);
      controls.minDistance = span * 0.68;
      controls.maxDistance = span * 3.2;
      controls.update();
      onLoaded();
    };

    buildModel().catch((error) => {
      console.error(error);
    });

    return () => {
      stopped = true;
      resizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
      controls.dispose();
      renderer.dispose();
      if (rootRef.current) {
        scene.remove(rootRef.current);
        disposeObject(rootRef.current);
      }
      renderer.domElement.remove();
      rootRef.current = null;
      materialsRef.current = [];
      cameraRef.current = null;
      controlsRef.current = null;
    };
  }, [animal, captureMode, format, modelFile, onLoaded]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    if (captureMode) {
      root.visible = true;
      root.scale.setScalar(1);
      materialsRef.current.forEach((material) => {
        material.transparent = false;
        material.opacity = 1;
      });
      return;
    }

    if (revealFrameRef.current) {
      window.cancelAnimationFrame(revealFrameRef.current);
    }

    if (!ready) {
      root.visible = false;
      root.scale.setScalar(0.82);
      materialsRef.current.forEach((material) => {
        material.transparent = true;
        material.opacity = 0;
      });
      return;
    }

    root.visible = true;
    const startedAt = performance.now();

    const reveal = (now: number) => {
      const progress = Math.min((now - startedAt) / 900, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      root.scale.setScalar(0.82 + eased * 0.18);
      materialsRef.current.forEach((material) => {
        material.opacity = eased;
        material.transparent = progress < 1;
      });

      if (progress < 1) {
        revealFrameRef.current = window.requestAnimationFrame(reveal);
      }
    };

    revealFrameRef.current = window.requestAnimationFrame(reveal);

    return () => {
      if (revealFrameRef.current) {
        window.cancelAnimationFrame(revealFrameRef.current);
      }
    };
  }, [captureMode, ready, replayKey]);

  return <div className="model-canvas" ref={mountRef} />;
}
