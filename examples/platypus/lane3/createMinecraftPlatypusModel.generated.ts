import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : new THREE.Color(typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F'),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clamp01(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: Math.max(1, readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: Math.max(1, readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clamp01(readLayerNumber(spec.specularIntensity, ['base'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    if (bumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = bumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    if (displacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = displacementScale;
      material.displacementBias = -displacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Minecraft Platypus
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createMinecraftPlatypusModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Minecraft Platypus";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"aspect": 1.0, "fovDegrees": 40.0, "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review.", "orientation": {"pitch": 0.0, "roll": 0.0, "yaw": 0.0}, "positionHint": [0.0, 0.0, 3.0], "solved": false}, "approximationNotes": []};

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["fur"] = createSculptMaterial(
    "fur",
    {"albedo": {"dominant": "#6f4525", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#4c2d1c", "#946039"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#6f4525", "color": "#6f4525", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#6f4525", "#4c2d1c", "#946039"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#4c2d1c"}, "id": "fur", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "fur-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Fur", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.78, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["fur_dark"] = createSculptMaterial(
    "fur_dark",
    {"albedo": {"dominant": "#3a2417", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#24150e", "#5a3822"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#3a2417", "color": "#3a2417", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#3a2417", "#24150e", "#5a3822"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#24150e"}, "id": "fur_dark", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "fur_dark-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Fur Dark", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.82, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["underfur"] = createSculptMaterial(
    "underfur",
    {"albedo": {"dominant": "#aa8358", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#75583b", "#d7ad7a"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#aa8358", "color": "#aa8358", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#aa8358", "#75583b", "#d7ad7a"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#75583b"}, "id": "underfur", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "underfur-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Underfur", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.84, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["bill"] = createSculptMaterial(
    "bill",
    {"albedo": {"dominant": "#4c5865", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#303944", "#718091"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#4c5865", "color": "#4c5865", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#4c5865", "#303944", "#718091"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#303944"}, "id": "bill", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "bill-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Bill", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.68, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["web"] = createSculptMaterial(
    "web",
    {"albedo": {"dominant": "#46515d", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#29333d", "#687887"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#46515d", "color": "#46515d", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#46515d", "#29333d", "#687887"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#29333d"}, "id": "web", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "web-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Web", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.72, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["tail"] = createSculptMaterial(
    "tail",
    {"albedo": {"dominant": "#35271f", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#201711", "#554034"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#35271f", "color": "#35271f", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#35271f", "#201711", "#554034"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#201711"}, "id": "tail", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "tail-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Tail", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.86, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["eye"] = createSculptMaterial(
    "eye",
    {"albedo": {"dominant": "#090909", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#020202", "#1d1d1d"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#090909", "color": "#090909", "colorVariation": {"amplitude": 0.02, "heightCorrelation": 0.16, "palette": ["#090909", "#020202", "#1d1d1d"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#020202"}, "id": "eye", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "eye-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Eye", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.32, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["glint"] = createSculptMaterial(
    "glint",
    {"albedo": {"dominant": "#f4f4ef", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#bfc2bd", "#ffffff"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#f4f4ef", "color": "#f4f4ef", "colorVariation": {"amplitude": 0.02, "heightCorrelation": 0.16, "palette": ["#f4f4ef", "#bfc2bd", "#ffffff"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#bfc2bd"}, "id": "glint", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "glint-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Glint", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.24, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["nostril"] = createSculptMaterial(
    "nostril",
    {"albedo": {"dominant": "#151b22", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#070a0d", "#2b3540"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#151b22", "color": "#151b22", "colorVariation": {"amplitude": 0.02, "heightCorrelation": 0.16, "palette": ["#151b22", "#070a0d", "#2b3540"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#070a0d"}, "id": "nostril", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "nostril-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Nostril", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.46, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_body_main_0 = null;
  const endpoint_body_main_0 = makeAttachmentEndpoint(attachment_body_main_0);
  const node_body_main_0 = new THREE.Group();
  node_body_main_0.name = "Main body__pivot";
  if (endpoint_body_main_0) {
    node_body_main_0.position.copy(endpoint_body_main_0.start);
    node_body_main_0.rotation.set(0, 0, 0);
    node_body_main_0.scale.set(1, 1, 1);
  } else {
    node_body_main_0.position.set(0.0, 7.5, 0.0);
    node_body_main_0.rotation.set(0.0, 0.0, 0.0);
    node_body_main_0.scale.set(10.0, 7.0, 14.0);
  }
  node_body_main_0.userData.sculptComponent = {"actionProfile": {"animationRole": "body_main", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [10, 7, 14], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "body_main", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 69, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(76, 45, 28, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["long-low-body", "pixel-fur"], "dimensions": {"confidence": 0.9, "depth": 14, "height": 7, "units": "Blockbench units", "width": 10}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "body_main", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["long-low-body", "pixel-fur"], "material": "fur", "materialLayers": ["fur"], "name": "Main body", "parent": null, "primitive": "box", "role": "long low torso", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 7.5, 0], "rotation": [0.0, 0.0, 0.0], "scale": [10, 7, 14]}};
  node_body_main_0.userData.actionProfile = {"animationRole": "body_main", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [10, 7, 14], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "body_main", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_body_main_0);
  nodes["body_main"] = node_body_main_0;
  const mesh_body_main_0Geometry = endpoint_body_main_0
    ? new THREE.CylinderGeometry(endpoint_body_main_0.endRadius, endpoint_body_main_0.baseRadius, endpoint_body_main_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_body_main_0 = new THREE.Mesh(
    mesh_body_main_0Geometry,
    materialMap["fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_main_0.name = "Main body";
  if (endpoint_body_main_0) {
    mesh_body_main_0.position.copy(endpoint_body_main_0.midpoint);
    mesh_body_main_0.quaternion.copy(endpoint_body_main_0.quaternion);
  }
  mesh_body_main_0.castShadow = options.castShadow ?? true;
  mesh_body_main_0.receiveShadow = options.receiveShadow ?? true;
  mesh_body_main_0.userData.sculptComponent = {"actionProfile": {"animationRole": "body_main", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [10, 7, 14], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "body_main", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 69, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(76, 45, 28, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["long-low-body", "pixel-fur"], "dimensions": {"confidence": 0.9, "depth": 14, "height": 7, "units": "Blockbench units", "width": 10}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "body_main", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["long-low-body", "pixel-fur"], "material": "fur", "materialLayers": ["fur"], "name": "Main body", "parent": null, "primitive": "box", "role": "long low torso", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 7.5, 0], "rotation": [0.0, 0.0, 0.0], "scale": [10, 7, 14]}};
  node_body_main_0.add(mesh_body_main_0);
  meshes["body_main"] = mesh_body_main_0;
  colliders["body_main"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [10, 7, 14], "type": "box"};
  destructionGroups["body_main"] ??= [];
  destructionGroups["body_main"].push(node_body_main_0);

  const attachment_shoulders_1 = null;
  const endpoint_shoulders_1 = makeAttachmentEndpoint(attachment_shoulders_1);
  const node_shoulders_1 = new THREE.Group();
  node_shoulders_1.name = "Shoulder mass__pivot";
  if (endpoint_shoulders_1) {
    node_shoulders_1.position.copy(endpoint_shoulders_1.start);
    node_shoulders_1.rotation.set(0, 0, 0);
    node_shoulders_1.scale.set(1, 1, 1);
  } else {
    node_shoulders_1.position.set(0.0, 7.4, 5.0);
    node_shoulders_1.rotation.set(0.0, 0.0, 0.0);
    node_shoulders_1.scale.set(10.5, 7.5, 5.5);
  }
  node_shoulders_1.userData.sculptComponent = {"actionProfile": {"animationRole": "shoulders", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [10.5, 7.5, 5.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "shoulders", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 69, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(76, 45, 28, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["pixel-fur"], "dimensions": {"confidence": 0.9, "depth": 5.5, "height": 7.5, "units": "Blockbench units", "width": 10.5}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "shoulders", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["pixel-fur", "square-side-eye-placement"], "material": "fur", "materialLayers": ["fur"], "name": "Shoulder mass", "parent": null, "primitive": "box", "role": "broad shoulder block", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 7.4, 5], "rotation": [0.0, 0.0, 0.0], "scale": [10.5, 7.5, 5.5]}};
  node_shoulders_1.userData.actionProfile = {"animationRole": "shoulders", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [10.5, 7.5, 5.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "shoulders", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_shoulders_1);
  nodes["shoulders"] = node_shoulders_1;
  const mesh_shoulders_1Geometry = endpoint_shoulders_1
    ? new THREE.CylinderGeometry(endpoint_shoulders_1.endRadius, endpoint_shoulders_1.baseRadius, endpoint_shoulders_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_shoulders_1 = new THREE.Mesh(
    mesh_shoulders_1Geometry,
    materialMap["fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulders_1.name = "Shoulder mass";
  if (endpoint_shoulders_1) {
    mesh_shoulders_1.position.copy(endpoint_shoulders_1.midpoint);
    mesh_shoulders_1.quaternion.copy(endpoint_shoulders_1.quaternion);
  }
  mesh_shoulders_1.castShadow = options.castShadow ?? true;
  mesh_shoulders_1.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulders_1.userData.sculptComponent = {"actionProfile": {"animationRole": "shoulders", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [10.5, 7.5, 5.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "shoulders", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 69, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(76, 45, 28, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["pixel-fur"], "dimensions": {"confidence": 0.9, "depth": 5.5, "height": 7.5, "units": "Blockbench units", "width": 10.5}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "shoulders", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["pixel-fur", "square-side-eye-placement"], "material": "fur", "materialLayers": ["fur"], "name": "Shoulder mass", "parent": null, "primitive": "box", "role": "broad shoulder block", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 7.4, 5], "rotation": [0.0, 0.0, 0.0], "scale": [10.5, 7.5, 5.5]}};
  node_shoulders_1.add(mesh_shoulders_1);
  meshes["shoulders"] = mesh_shoulders_1;
  colliders["shoulders"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [10.5, 7.5, 5.5], "type": "box"};
  destructionGroups["shoulders"] ??= [];
  destructionGroups["shoulders"].push(node_shoulders_1);

  const attachment_neck_2 = null;
  const endpoint_neck_2 = makeAttachmentEndpoint(attachment_neck_2);
  const node_neck_2 = new THREE.Group();
  node_neck_2.name = "Neck bridge__pivot";
  if (endpoint_neck_2) {
    node_neck_2.position.copy(endpoint_neck_2.start);
    node_neck_2.rotation.set(0, 0, 0);
    node_neck_2.scale.set(1, 1, 1);
  } else {
    node_neck_2.position.set(0.0, 8.0, 7.2);
    node_neck_2.rotation.set(0.0, 0.0, 0.0);
    node_neck_2.scale.set(7.0, 5.5, 3.5);
  }
  node_neck_2.userData.sculptComponent = {"actionProfile": {"animationRole": "neck", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7, 5.5, 3.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "neck", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 69, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(76, 45, 28, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["pixel-fur"], "dimensions": {"confidence": 0.9, "depth": 3.5, "height": 5.5, "units": "Blockbench units", "width": 7}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "neck", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["pixel-fur"], "material": "fur", "materialLayers": ["fur"], "name": "Neck bridge", "parent": null, "primitive": "box", "role": "short neck bridge", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 8, 7.2], "rotation": [0.0, 0.0, 0.0], "scale": [7, 5.5, 3.5]}};
  node_neck_2.userData.actionProfile = {"animationRole": "neck", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7, 5.5, 3.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "neck", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_neck_2);
  nodes["neck"] = node_neck_2;
  const mesh_neck_2Geometry = endpoint_neck_2
    ? new THREE.CylinderGeometry(endpoint_neck_2.endRadius, endpoint_neck_2.baseRadius, endpoint_neck_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_neck_2 = new THREE.Mesh(
    mesh_neck_2Geometry,
    materialMap["fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_neck_2.name = "Neck bridge";
  if (endpoint_neck_2) {
    mesh_neck_2.position.copy(endpoint_neck_2.midpoint);
    mesh_neck_2.quaternion.copy(endpoint_neck_2.quaternion);
  }
  mesh_neck_2.castShadow = options.castShadow ?? true;
  mesh_neck_2.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_2.userData.sculptComponent = {"actionProfile": {"animationRole": "neck", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7, 5.5, 3.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "neck", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 69, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(76, 45, 28, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["pixel-fur"], "dimensions": {"confidence": 0.9, "depth": 3.5, "height": 5.5, "units": "Blockbench units", "width": 7}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "neck", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["pixel-fur"], "material": "fur", "materialLayers": ["fur"], "name": "Neck bridge", "parent": null, "primitive": "box", "role": "short neck bridge", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 8, 7.2], "rotation": [0.0, 0.0, 0.0], "scale": [7, 5.5, 3.5]}};
  node_neck_2.add(mesh_neck_2);
  meshes["neck"] = mesh_neck_2;
  colliders["neck"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [7, 5.5, 3.5], "type": "box"};
  destructionGroups["neck"] ??= [];
  destructionGroups["neck"].push(node_neck_2);

  const attachment_head_main_3 = null;
  const endpoint_head_main_3 = makeAttachmentEndpoint(attachment_head_main_3);
  const node_head_main_3 = new THREE.Group();
  node_head_main_3.name = "Head__pivot";
  if (endpoint_head_main_3) {
    node_head_main_3.position.copy(endpoint_head_main_3.start);
    node_head_main_3.rotation.set(0, 0, 0);
    node_head_main_3.scale.set(1, 1, 1);
  } else {
    node_head_main_3.position.set(0.0, 8.2, 9.7);
    node_head_main_3.rotation.set(0.0, 0.0, 0.0);
    node_head_main_3.scale.set(8.0, 7.0, 6.5);
  }
  node_head_main_3.userData.sculptComponent = {"actionProfile": {"animationRole": "head_main", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8, 7, 6.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "head_main", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 69, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(76, 45, 28, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["pixel-fur"], "dimensions": {"confidence": 0.9, "depth": 6.5, "height": 7, "units": "Blockbench units", "width": 8}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "head_main", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["pixel-fur"], "material": "fur", "materialLayers": ["fur"], "name": "Head", "parent": null, "primitive": "box", "role": "broad platypus head", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 8.2, 9.7], "rotation": [0.0, 0.0, 0.0], "scale": [8, 7, 6.5]}};
  node_head_main_3.userData.actionProfile = {"animationRole": "head_main", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8, 7, 6.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "head_main", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_head_main_3);
  nodes["head_main"] = node_head_main_3;
  const mesh_head_main_3Geometry = endpoint_head_main_3
    ? new THREE.CylinderGeometry(endpoint_head_main_3.endRadius, endpoint_head_main_3.baseRadius, endpoint_head_main_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_head_main_3 = new THREE.Mesh(
    mesh_head_main_3Geometry,
    materialMap["fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_main_3.name = "Head";
  if (endpoint_head_main_3) {
    mesh_head_main_3.position.copy(endpoint_head_main_3.midpoint);
    mesh_head_main_3.quaternion.copy(endpoint_head_main_3.quaternion);
  }
  mesh_head_main_3.castShadow = options.castShadow ?? true;
  mesh_head_main_3.receiveShadow = options.receiveShadow ?? true;
  mesh_head_main_3.userData.sculptComponent = {"actionProfile": {"animationRole": "head_main", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8, 7, 6.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur", "detachableFragments": [], "fractureGroup": "head_main", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 69, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(76, 45, 28, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["pixel-fur"], "dimensions": {"confidence": 0.9, "depth": 6.5, "height": 7, "units": "Blockbench units", "width": 8}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "head_main", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["pixel-fur"], "material": "fur", "materialLayers": ["fur"], "name": "Head", "parent": null, "primitive": "box", "role": "broad platypus head", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 8.2, 9.7], "rotation": [0.0, 0.0, 0.0], "scale": [8, 7, 6.5]}};
  node_head_main_3.add(mesh_head_main_3);
  meshes["head_main"] = mesh_head_main_3;
  colliders["head_main"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [8, 7, 6.5], "type": "box"};
  destructionGroups["head_main"] ??= [];
  destructionGroups["head_main"].push(node_head_main_3);

  const attachment_bill_base_4 = null;
  const endpoint_bill_base_4 = makeAttachmentEndpoint(attachment_bill_base_4);
  const node_bill_base_4 = new THREE.Group();
  node_bill_base_4.name = "Bill base__pivot";
  if (endpoint_bill_base_4) {
    node_bill_base_4.position.copy(endpoint_bill_base_4.start);
    node_bill_base_4.rotation.set(0, 0, 0);
    node_bill_base_4.scale.set(1, 1, 1);
  } else {
    node_bill_base_4.position.set(0.0, 7.2, 13.3);
    node_bill_base_4.rotation.set(0.0, 0.0, 0.0);
    node_bill_base_4.scale.set(7.0, 3.0, 4.0);
  }
  node_bill_base_4.userData.sculptComponent = {"actionProfile": {"animationRole": "bill_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7.0, 3, 4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "bill", "detachableFragments": [], "fractureGroup": "bill_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(76, 88, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 57, 68, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4, "height": 3, "units": "Blockbench units", "width": 7.0}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "bill_base", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "bill", "materialLayers": ["bill"], "name": "Bill base", "parent": null, "primitive": "box", "role": "wide bill base", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 7.2, 13.3], "rotation": [0.0, 0.0, 0.0], "scale": [7.0, 3, 4]}};
  node_bill_base_4.userData.actionProfile = {"animationRole": "bill_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7.0, 3, 4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "bill", "detachableFragments": [], "fractureGroup": "bill_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_bill_base_4);
  nodes["bill_base"] = node_bill_base_4;
  const mesh_bill_base_4Geometry = endpoint_bill_base_4
    ? new THREE.CylinderGeometry(endpoint_bill_base_4.endRadius, endpoint_bill_base_4.baseRadius, endpoint_bill_base_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_bill_base_4 = new THREE.Mesh(
    mesh_bill_base_4Geometry,
    materialMap["bill"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bill_base_4.name = "Bill base";
  if (endpoint_bill_base_4) {
    mesh_bill_base_4.position.copy(endpoint_bill_base_4.midpoint);
    mesh_bill_base_4.quaternion.copy(endpoint_bill_base_4.quaternion);
  }
  mesh_bill_base_4.castShadow = options.castShadow ?? true;
  mesh_bill_base_4.receiveShadow = options.receiveShadow ?? true;
  mesh_bill_base_4.userData.sculptComponent = {"actionProfile": {"animationRole": "bill_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7.0, 3, 4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "bill", "detachableFragments": [], "fractureGroup": "bill_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(76, 88, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 57, 68, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4, "height": 3, "units": "Blockbench units", "width": 7.0}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "bill_base", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "bill", "materialLayers": ["bill"], "name": "Bill base", "parent": null, "primitive": "box", "role": "wide bill base", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 7.2, 13.3], "rotation": [0.0, 0.0, 0.0], "scale": [7.0, 3, 4]}};
  node_bill_base_4.add(mesh_bill_base_4);
  meshes["bill_base"] = mesh_bill_base_4;
  colliders["bill_base"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [7.0, 3, 4], "type": "box"};
  destructionGroups["bill_base"] ??= [];
  destructionGroups["bill_base"].push(node_bill_base_4);

  const attachment_bill_tip_5 = null;
  const endpoint_bill_tip_5 = makeAttachmentEndpoint(attachment_bill_tip_5);
  const node_bill_tip_5 = new THREE.Group();
  node_bill_tip_5.name = "Bill tip__pivot";
  if (endpoint_bill_tip_5) {
    node_bill_tip_5.position.copy(endpoint_bill_tip_5.start);
    node_bill_tip_5.rotation.set(0, 0, 0);
    node_bill_tip_5.scale.set(1, 1, 1);
  } else {
    node_bill_tip_5.position.set(0.0, 6.9, 17.0);
    node_bill_tip_5.rotation.set(0.0, 0.0, 0.0);
    node_bill_tip_5.scale.set(7.5, 2.5, 4.5);
  }
  node_bill_tip_5.userData.sculptComponent = {"actionProfile": {"animationRole": "bill_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7.5, 2.5, 4.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "bill", "detachableFragments": [], "fractureGroup": "bill_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(76, 88, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 57, 68, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["broad-bill"], "dimensions": {"confidence": 0.9, "depth": 4.5, "height": 2.5, "units": "Blockbench units", "width": 7.5}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "bill_tip", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["broad-bill"], "material": "bill", "materialLayers": ["bill"], "name": "Bill tip", "parent": null, "primitive": "box", "role": "broad flat bill tip", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 6.9, 17], "rotation": [0.0, 0.0, 0.0], "scale": [7.5, 2.5, 4.5]}};
  node_bill_tip_5.userData.actionProfile = {"animationRole": "bill_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7.5, 2.5, 4.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "bill", "detachableFragments": [], "fractureGroup": "bill_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_bill_tip_5);
  nodes["bill_tip"] = node_bill_tip_5;
  const mesh_bill_tip_5Geometry = endpoint_bill_tip_5
    ? new THREE.CylinderGeometry(endpoint_bill_tip_5.endRadius, endpoint_bill_tip_5.baseRadius, endpoint_bill_tip_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_bill_tip_5 = new THREE.Mesh(
    mesh_bill_tip_5Geometry,
    materialMap["bill"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bill_tip_5.name = "Bill tip";
  if (endpoint_bill_tip_5) {
    mesh_bill_tip_5.position.copy(endpoint_bill_tip_5.midpoint);
    mesh_bill_tip_5.quaternion.copy(endpoint_bill_tip_5.quaternion);
  }
  mesh_bill_tip_5.castShadow = options.castShadow ?? true;
  mesh_bill_tip_5.receiveShadow = options.receiveShadow ?? true;
  mesh_bill_tip_5.userData.sculptComponent = {"actionProfile": {"animationRole": "bill_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [7.5, 2.5, 4.5], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "bill", "detachableFragments": [], "fractureGroup": "bill_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(76, 88, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 57, 68, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["broad-bill"], "dimensions": {"confidence": 0.9, "depth": 4.5, "height": 2.5, "units": "Blockbench units", "width": 7.5}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "bill_tip", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["broad-bill"], "material": "bill", "materialLayers": ["bill"], "name": "Bill tip", "parent": null, "primitive": "box", "role": "broad flat bill tip", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 6.9, 17], "rotation": [0.0, 0.0, 0.0], "scale": [7.5, 2.5, 4.5]}};
  node_bill_tip_5.add(mesh_bill_tip_5);
  meshes["bill_tip"] = mesh_bill_tip_5;
  colliders["bill_tip"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [7.5, 2.5, 4.5], "type": "box"};
  destructionGroups["bill_tip"] ??= [];
  destructionGroups["bill_tip"].push(node_bill_tip_5);

  const attachment_tail_base_6 = null;
  const endpoint_tail_base_6 = makeAttachmentEndpoint(attachment_tail_base_6);
  const node_tail_base_6 = new THREE.Group();
  node_tail_base_6.name = "Tail base__pivot";
  if (endpoint_tail_base_6) {
    node_tail_base_6.position.copy(endpoint_tail_base_6.start);
    node_tail_base_6.rotation.set(0, 0, 0);
    node_tail_base_6.scale.set(1, 1, 1);
  } else {
    node_tail_base_6.position.set(0.0, 6.2, -9.0);
    node_tail_base_6.rotation.set(-0.08726646259971647, 0.0, 0.0);
    node_tail_base_6.scale.set(8.5, 2.2, 7.0);
  }
  node_tail_base_6.userData.sculptComponent = {"actionProfile": {"animationRole": "tail_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8.5, 2.2, 7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail", "detachableFragments": [], "fractureGroup": "tail_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(53, 39, 31, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(32, 23, 17, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["paddle-tail"], "dimensions": {"confidence": 0.9, "depth": 7, "height": 2.2, "units": "Blockbench units", "width": 8.5}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tail_base", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["paddle-tail"], "material": "tail", "materialLayers": ["tail"], "name": "Tail base", "parent": null, "primitive": "box", "role": "wide paddle tail base", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 6.2, -9], "rotation": [-0.08726646259971647, 0.0, 0.0], "scale": [8.5, 2.2, 7]}};
  node_tail_base_6.userData.actionProfile = {"animationRole": "tail_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8.5, 2.2, 7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail", "detachableFragments": [], "fractureGroup": "tail_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_tail_base_6);
  nodes["tail_base"] = node_tail_base_6;
  const mesh_tail_base_6Geometry = endpoint_tail_base_6
    ? new THREE.CylinderGeometry(endpoint_tail_base_6.endRadius, endpoint_tail_base_6.baseRadius, endpoint_tail_base_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tail_base_6 = new THREE.Mesh(
    mesh_tail_base_6Geometry,
    materialMap["tail"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_base_6.name = "Tail base";
  if (endpoint_tail_base_6) {
    mesh_tail_base_6.position.copy(endpoint_tail_base_6.midpoint);
    mesh_tail_base_6.quaternion.copy(endpoint_tail_base_6.quaternion);
  }
  mesh_tail_base_6.castShadow = options.castShadow ?? true;
  mesh_tail_base_6.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_base_6.userData.sculptComponent = {"actionProfile": {"animationRole": "tail_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8.5, 2.2, 7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail", "detachableFragments": [], "fractureGroup": "tail_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(53, 39, 31, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(32, 23, 17, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["paddle-tail"], "dimensions": {"confidence": 0.9, "depth": 7, "height": 2.2, "units": "Blockbench units", "width": 8.5}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tail_base", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["paddle-tail"], "material": "tail", "materialLayers": ["tail"], "name": "Tail base", "parent": null, "primitive": "box", "role": "wide paddle tail base", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 6.2, -9], "rotation": [-0.08726646259971647, 0.0, 0.0], "scale": [8.5, 2.2, 7]}};
  node_tail_base_6.add(mesh_tail_base_6);
  meshes["tail_base"] = mesh_tail_base_6;
  colliders["tail_base"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [8.5, 2.2, 7], "type": "box"};
  destructionGroups["tail_base"] ??= [];
  destructionGroups["tail_base"].push(node_tail_base_6);

  const attachment_tail_tip_7 = null;
  const endpoint_tail_tip_7 = makeAttachmentEndpoint(attachment_tail_tip_7);
  const node_tail_tip_7 = new THREE.Group();
  node_tail_tip_7.name = "Tail tip__pivot";
  if (endpoint_tail_tip_7) {
    node_tail_tip_7.position.copy(endpoint_tail_tip_7.start);
    node_tail_tip_7.rotation.set(0, 0, 0);
    node_tail_tip_7.scale.set(1, 1, 1);
  } else {
    node_tail_tip_7.position.set(0.0, 5.7, -14.0);
    node_tail_tip_7.rotation.set(-0.13962634015954636, 0.0, 0.0);
    node_tail_tip_7.scale.set(8.0, 1.8, 6.0);
  }
  node_tail_tip_7.userData.sculptComponent = {"actionProfile": {"animationRole": "tail_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8, 1.8, 6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail", "detachableFragments": [], "fractureGroup": "tail_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(53, 39, 31, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(32, 23, 17, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 6, "height": 1.8, "units": "Blockbench units", "width": 8}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tail_tip", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "tail", "materialLayers": ["tail"], "name": "Tail tip", "parent": null, "primitive": "box", "role": "flat paddle tail tip", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 5.7, -14], "rotation": [-0.13962634015954636, 0.0, 0.0], "scale": [8, 1.8, 6]}};
  node_tail_tip_7.userData.actionProfile = {"animationRole": "tail_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8, 1.8, 6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail", "detachableFragments": [], "fractureGroup": "tail_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_tail_tip_7);
  nodes["tail_tip"] = node_tail_tip_7;
  const mesh_tail_tip_7Geometry = endpoint_tail_tip_7
    ? new THREE.CylinderGeometry(endpoint_tail_tip_7.endRadius, endpoint_tail_tip_7.baseRadius, endpoint_tail_tip_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tail_tip_7 = new THREE.Mesh(
    mesh_tail_tip_7Geometry,
    materialMap["tail"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_tip_7.name = "Tail tip";
  if (endpoint_tail_tip_7) {
    mesh_tail_tip_7.position.copy(endpoint_tail_tip_7.midpoint);
    mesh_tail_tip_7.quaternion.copy(endpoint_tail_tip_7.quaternion);
  }
  mesh_tail_tip_7.castShadow = options.castShadow ?? true;
  mesh_tail_tip_7.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_tip_7.userData.sculptComponent = {"actionProfile": {"animationRole": "tail_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8, 1.8, 6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail", "detachableFragments": [], "fractureGroup": "tail_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(53, 39, 31, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(32, 23, 17, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 6, "height": 1.8, "units": "Blockbench units", "width": 8}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tail_tip", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "tail", "materialLayers": ["tail"], "name": "Tail tip", "parent": null, "primitive": "box", "role": "flat paddle tail tip", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 5.7, -14], "rotation": [-0.13962634015954636, 0.0, 0.0], "scale": [8, 1.8, 6]}};
  node_tail_tip_7.add(mesh_tail_tip_7);
  meshes["tail_tip"] = mesh_tail_tip_7;
  colliders["tail_tip"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [8, 1.8, 6], "type": "box"};
  destructionGroups["tail_tip"] ??= [];
  destructionGroups["tail_tip"].push(node_tail_tip_7);

  const attachment_front_left_leg_8 = null;
  const endpoint_front_left_leg_8 = makeAttachmentEndpoint(attachment_front_left_leg_8);
  const node_front_left_leg_8 = new THREE.Group();
  node_front_left_leg_8.name = "Front left leg__pivot";
  if (endpoint_front_left_leg_8) {
    node_front_left_leg_8.position.copy(endpoint_front_left_leg_8.start);
    node_front_left_leg_8.rotation.set(0, 0, 0);
    node_front_left_leg_8.scale.set(1, 1, 1);
  } else {
    node_front_left_leg_8.position.set(3.7, 3.8, 4.2);
    node_front_left_leg_8.rotation.set(0.0, 0.0, 0.0);
    node_front_left_leg_8.scale.set(2.5, 5.0, 2.7);
  }
  node_front_left_leg_8.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "front_left_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 36, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(36, 21, 14, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["dark-lower-legs"], "dimensions": {"confidence": 0.9, "depth": 2.7, "height": 5, "units": "Blockbench units", "width": 2.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_leg", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["dark-lower-legs"], "material": "fur_dark", "materialLayers": ["fur_dark"], "name": "Front left leg", "parent": null, "primitive": "box", "role": "front left leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 3.8, 4.2], "rotation": [0.0, 0.0, 0.0], "scale": [2.5, 5, 2.7]}};
  node_front_left_leg_8.userData.actionProfile = {"animationRole": "front_left_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "front_left_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_left_leg_8);
  nodes["front_left_leg"] = node_front_left_leg_8;
  const mesh_front_left_leg_8Geometry = endpoint_front_left_leg_8
    ? new THREE.CylinderGeometry(endpoint_front_left_leg_8.endRadius, endpoint_front_left_leg_8.baseRadius, endpoint_front_left_leg_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_left_leg_8 = new THREE.Mesh(
    mesh_front_left_leg_8Geometry,
    materialMap["fur_dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_left_leg_8.name = "Front left leg";
  if (endpoint_front_left_leg_8) {
    mesh_front_left_leg_8.position.copy(endpoint_front_left_leg_8.midpoint);
    mesh_front_left_leg_8.quaternion.copy(endpoint_front_left_leg_8.quaternion);
  }
  mesh_front_left_leg_8.castShadow = options.castShadow ?? true;
  mesh_front_left_leg_8.receiveShadow = options.receiveShadow ?? true;
  mesh_front_left_leg_8.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "front_left_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 36, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(36, 21, 14, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["dark-lower-legs"], "dimensions": {"confidence": 0.9, "depth": 2.7, "height": 5, "units": "Blockbench units", "width": 2.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_leg", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["dark-lower-legs"], "material": "fur_dark", "materialLayers": ["fur_dark"], "name": "Front left leg", "parent": null, "primitive": "box", "role": "front left leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 3.8, 4.2], "rotation": [0.0, 0.0, 0.0], "scale": [2.5, 5, 2.7]}};
  node_front_left_leg_8.add(mesh_front_left_leg_8);
  meshes["front_left_leg"] = mesh_front_left_leg_8;
  colliders["front_left_leg"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"};
  destructionGroups["front_left_leg"] ??= [];
  destructionGroups["front_left_leg"].push(node_front_left_leg_8);

  const attachment_front_left_foot_9 = null;
  const endpoint_front_left_foot_9 = makeAttachmentEndpoint(attachment_front_left_foot_9);
  const node_front_left_foot_9 = new THREE.Group();
  node_front_left_foot_9.name = "Front left webbed foot__pivot";
  if (endpoint_front_left_foot_9) {
    node_front_left_foot_9.position.copy(endpoint_front_left_foot_9.start);
    node_front_left_foot_9.rotation.set(0, 0, 0);
    node_front_left_foot_9.scale.set(1, 1, 1);
  } else {
    node_front_left_foot_9.position.set(3.7, 0.9, 4.8);
    node_front_left_foot_9.rotation.set(0.0, 0.0, 0.0);
    node_front_left_foot_9.scale.set(4.2, 1.4, 3.8);
  }
  node_front_left_foot_9.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.8, "height": 1.4, "units": "Blockbench units", "width": 4.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_foot", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front left webbed foot", "parent": null, "primitive": "box", "role": "front left webbed foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 0.9, 4.8], "rotation": [0.0, 0.0, 0.0], "scale": [4.2, 1.4, 3.8]}};
  node_front_left_foot_9.userData.actionProfile = {"animationRole": "front_left_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_left_foot_9);
  nodes["front_left_foot"] = node_front_left_foot_9;
  const mesh_front_left_foot_9Geometry = endpoint_front_left_foot_9
    ? new THREE.CylinderGeometry(endpoint_front_left_foot_9.endRadius, endpoint_front_left_foot_9.baseRadius, endpoint_front_left_foot_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_left_foot_9 = new THREE.Mesh(
    mesh_front_left_foot_9Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_left_foot_9.name = "Front left webbed foot";
  if (endpoint_front_left_foot_9) {
    mesh_front_left_foot_9.position.copy(endpoint_front_left_foot_9.midpoint);
    mesh_front_left_foot_9.quaternion.copy(endpoint_front_left_foot_9.quaternion);
  }
  mesh_front_left_foot_9.castShadow = options.castShadow ?? true;
  mesh_front_left_foot_9.receiveShadow = options.receiveShadow ?? true;
  mesh_front_left_foot_9.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.8, "height": 1.4, "units": "Blockbench units", "width": 4.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_foot", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front left webbed foot", "parent": null, "primitive": "box", "role": "front left webbed foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 0.9, 4.8], "rotation": [0.0, 0.0, 0.0], "scale": [4.2, 1.4, 3.8]}};
  node_front_left_foot_9.add(mesh_front_left_foot_9);
  meshes["front_left_foot"] = mesh_front_left_foot_9;
  colliders["front_left_foot"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"};
  destructionGroups["front_left_foot"] ??= [];
  destructionGroups["front_left_foot"].push(node_front_left_foot_9);

  const attachment_front_left_toe_1_10 = null;
  const endpoint_front_left_toe_1_10 = makeAttachmentEndpoint(attachment_front_left_toe_1_10);
  const node_front_left_toe_1_10 = new THREE.Group();
  node_front_left_toe_1_10.name = "Front left outer toe__pivot";
  if (endpoint_front_left_toe_1_10) {
    node_front_left_toe_1_10.position.copy(endpoint_front_left_toe_1_10.start);
    node_front_left_toe_1_10.rotation.set(0, 0, 0);
    node_front_left_toe_1_10.scale.set(1, 1, 1);
  } else {
    node_front_left_toe_1_10.position.set(2.45, 0.65, 6.5);
    node_front_left_toe_1_10.rotation.set(0.0, 0.0, 0.0);
    node_front_left_toe_1_10.scale.set(1.0, 0.8, 2.4);
  }
  node_front_left_toe_1_10.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_toe_1", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front left outer toe", "parent": null, "primitive": "box", "role": "front left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [2.45, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_left_toe_1_10.userData.actionProfile = {"animationRole": "front_left_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_left_toe_1_10);
  nodes["front_left_toe_1"] = node_front_left_toe_1_10;
  const mesh_front_left_toe_1_10Geometry = endpoint_front_left_toe_1_10
    ? new THREE.CylinderGeometry(endpoint_front_left_toe_1_10.endRadius, endpoint_front_left_toe_1_10.baseRadius, endpoint_front_left_toe_1_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_left_toe_1_10 = new THREE.Mesh(
    mesh_front_left_toe_1_10Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_left_toe_1_10.name = "Front left outer toe";
  if (endpoint_front_left_toe_1_10) {
    mesh_front_left_toe_1_10.position.copy(endpoint_front_left_toe_1_10.midpoint);
    mesh_front_left_toe_1_10.quaternion.copy(endpoint_front_left_toe_1_10.quaternion);
  }
  mesh_front_left_toe_1_10.castShadow = options.castShadow ?? true;
  mesh_front_left_toe_1_10.receiveShadow = options.receiveShadow ?? true;
  mesh_front_left_toe_1_10.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_toe_1", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front left outer toe", "parent": null, "primitive": "box", "role": "front left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [2.45, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_left_toe_1_10.add(mesh_front_left_toe_1_10);
  meshes["front_left_toe_1"] = mesh_front_left_toe_1_10;
  colliders["front_left_toe_1"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["front_left_toe_1"] ??= [];
  destructionGroups["front_left_toe_1"].push(node_front_left_toe_1_10);

  const attachment_front_left_toe_2_11 = null;
  const endpoint_front_left_toe_2_11 = makeAttachmentEndpoint(attachment_front_left_toe_2_11);
  const node_front_left_toe_2_11 = new THREE.Group();
  node_front_left_toe_2_11.name = "Front left middle toe__pivot";
  if (endpoint_front_left_toe_2_11) {
    node_front_left_toe_2_11.position.copy(endpoint_front_left_toe_2_11.start);
    node_front_left_toe_2_11.rotation.set(0, 0, 0);
    node_front_left_toe_2_11.scale.set(1, 1, 1);
  } else {
    node_front_left_toe_2_11.position.set(3.7, 0.65, 6.5);
    node_front_left_toe_2_11.rotation.set(0.0, 0.0, 0.0);
    node_front_left_toe_2_11.scale.set(1.0, 0.8, 2.4);
  }
  node_front_left_toe_2_11.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["webbed-front-feet"], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_toe_2", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": ["webbed-front-feet"], "material": "web", "materialLayers": ["web"], "name": "Front left middle toe", "parent": null, "primitive": "box", "role": "front left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_left_toe_2_11.userData.actionProfile = {"animationRole": "front_left_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_left_toe_2_11);
  nodes["front_left_toe_2"] = node_front_left_toe_2_11;
  const mesh_front_left_toe_2_11Geometry = endpoint_front_left_toe_2_11
    ? new THREE.CylinderGeometry(endpoint_front_left_toe_2_11.endRadius, endpoint_front_left_toe_2_11.baseRadius, endpoint_front_left_toe_2_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_left_toe_2_11 = new THREE.Mesh(
    mesh_front_left_toe_2_11Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_left_toe_2_11.name = "Front left middle toe";
  if (endpoint_front_left_toe_2_11) {
    mesh_front_left_toe_2_11.position.copy(endpoint_front_left_toe_2_11.midpoint);
    mesh_front_left_toe_2_11.quaternion.copy(endpoint_front_left_toe_2_11.quaternion);
  }
  mesh_front_left_toe_2_11.castShadow = options.castShadow ?? true;
  mesh_front_left_toe_2_11.receiveShadow = options.receiveShadow ?? true;
  mesh_front_left_toe_2_11.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["webbed-front-feet"], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_toe_2", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": ["webbed-front-feet"], "material": "web", "materialLayers": ["web"], "name": "Front left middle toe", "parent": null, "primitive": "box", "role": "front left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_left_toe_2_11.add(mesh_front_left_toe_2_11);
  meshes["front_left_toe_2"] = mesh_front_left_toe_2_11;
  colliders["front_left_toe_2"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["front_left_toe_2"] ??= [];
  destructionGroups["front_left_toe_2"].push(node_front_left_toe_2_11);

  const attachment_front_left_toe_3_12 = null;
  const endpoint_front_left_toe_3_12 = makeAttachmentEndpoint(attachment_front_left_toe_3_12);
  const node_front_left_toe_3_12 = new THREE.Group();
  node_front_left_toe_3_12.name = "Front left inner toe__pivot";
  if (endpoint_front_left_toe_3_12) {
    node_front_left_toe_3_12.position.copy(endpoint_front_left_toe_3_12.start);
    node_front_left_toe_3_12.rotation.set(0, 0, 0);
    node_front_left_toe_3_12.scale.set(1, 1, 1);
  } else {
    node_front_left_toe_3_12.position.set(4.95, 0.65, 6.5);
    node_front_left_toe_3_12.rotation.set(0.0, 0.0, 0.0);
    node_front_left_toe_3_12.scale.set(1.0, 0.8, 2.4);
  }
  node_front_left_toe_3_12.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_toe_3", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front left inner toe", "parent": null, "primitive": "box", "role": "front left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.95, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_left_toe_3_12.userData.actionProfile = {"animationRole": "front_left_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_left_toe_3_12);
  nodes["front_left_toe_3"] = node_front_left_toe_3_12;
  const mesh_front_left_toe_3_12Geometry = endpoint_front_left_toe_3_12
    ? new THREE.CylinderGeometry(endpoint_front_left_toe_3_12.endRadius, endpoint_front_left_toe_3_12.baseRadius, endpoint_front_left_toe_3_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_left_toe_3_12 = new THREE.Mesh(
    mesh_front_left_toe_3_12Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_left_toe_3_12.name = "Front left inner toe";
  if (endpoint_front_left_toe_3_12) {
    mesh_front_left_toe_3_12.position.copy(endpoint_front_left_toe_3_12.midpoint);
    mesh_front_left_toe_3_12.quaternion.copy(endpoint_front_left_toe_3_12.quaternion);
  }
  mesh_front_left_toe_3_12.castShadow = options.castShadow ?? true;
  mesh_front_left_toe_3_12.receiveShadow = options.receiveShadow ?? true;
  mesh_front_left_toe_3_12.userData.sculptComponent = {"actionProfile": {"animationRole": "front_left_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_left_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_left_toe_3", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front left inner toe", "parent": null, "primitive": "box", "role": "front left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.95, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_left_toe_3_12.add(mesh_front_left_toe_3_12);
  meshes["front_left_toe_3"] = mesh_front_left_toe_3_12;
  colliders["front_left_toe_3"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["front_left_toe_3"] ??= [];
  destructionGroups["front_left_toe_3"].push(node_front_left_toe_3_12);

  const attachment_front_right_leg_13 = null;
  const endpoint_front_right_leg_13 = makeAttachmentEndpoint(attachment_front_right_leg_13);
  const node_front_right_leg_13 = new THREE.Group();
  node_front_right_leg_13.name = "Front right leg__pivot";
  if (endpoint_front_right_leg_13) {
    node_front_right_leg_13.position.copy(endpoint_front_right_leg_13.start);
    node_front_right_leg_13.rotation.set(0, 0, 0);
    node_front_right_leg_13.scale.set(1, 1, 1);
  } else {
    node_front_right_leg_13.position.set(-3.7, 3.8, 4.2);
    node_front_right_leg_13.rotation.set(0.0, 0.0, 0.0);
    node_front_right_leg_13.scale.set(2.5, 5.0, 2.7);
  }
  node_front_right_leg_13.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "front_right_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 36, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(36, 21, 14, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.7, "height": 5, "units": "Blockbench units", "width": 2.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_leg", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "fur_dark", "materialLayers": ["fur_dark"], "name": "Front right leg", "parent": null, "primitive": "box", "role": "front right leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 3.8, 4.2], "rotation": [0.0, 0.0, 0.0], "scale": [2.5, 5, 2.7]}};
  node_front_right_leg_13.userData.actionProfile = {"animationRole": "front_right_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "front_right_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_right_leg_13);
  nodes["front_right_leg"] = node_front_right_leg_13;
  const mesh_front_right_leg_13Geometry = endpoint_front_right_leg_13
    ? new THREE.CylinderGeometry(endpoint_front_right_leg_13.endRadius, endpoint_front_right_leg_13.baseRadius, endpoint_front_right_leg_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_right_leg_13 = new THREE.Mesh(
    mesh_front_right_leg_13Geometry,
    materialMap["fur_dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_right_leg_13.name = "Front right leg";
  if (endpoint_front_right_leg_13) {
    mesh_front_right_leg_13.position.copy(endpoint_front_right_leg_13.midpoint);
    mesh_front_right_leg_13.quaternion.copy(endpoint_front_right_leg_13.quaternion);
  }
  mesh_front_right_leg_13.castShadow = options.castShadow ?? true;
  mesh_front_right_leg_13.receiveShadow = options.receiveShadow ?? true;
  mesh_front_right_leg_13.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "front_right_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 36, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(36, 21, 14, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.7, "height": 5, "units": "Blockbench units", "width": 2.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_leg", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "fur_dark", "materialLayers": ["fur_dark"], "name": "Front right leg", "parent": null, "primitive": "box", "role": "front right leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 3.8, 4.2], "rotation": [0.0, 0.0, 0.0], "scale": [2.5, 5, 2.7]}};
  node_front_right_leg_13.add(mesh_front_right_leg_13);
  meshes["front_right_leg"] = mesh_front_right_leg_13;
  colliders["front_right_leg"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"};
  destructionGroups["front_right_leg"] ??= [];
  destructionGroups["front_right_leg"].push(node_front_right_leg_13);

  const attachment_front_right_foot_14 = null;
  const endpoint_front_right_foot_14 = makeAttachmentEndpoint(attachment_front_right_foot_14);
  const node_front_right_foot_14 = new THREE.Group();
  node_front_right_foot_14.name = "Front right webbed foot__pivot";
  if (endpoint_front_right_foot_14) {
    node_front_right_foot_14.position.copy(endpoint_front_right_foot_14.start);
    node_front_right_foot_14.rotation.set(0, 0, 0);
    node_front_right_foot_14.scale.set(1, 1, 1);
  } else {
    node_front_right_foot_14.position.set(-3.7, 0.9, 4.8);
    node_front_right_foot_14.rotation.set(0.0, 0.0, 0.0);
    node_front_right_foot_14.scale.set(4.2, 1.4, 3.8);
  }
  node_front_right_foot_14.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.8, "height": 1.4, "units": "Blockbench units", "width": 4.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_foot", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front right webbed foot", "parent": null, "primitive": "box", "role": "front right webbed foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 0.9, 4.8], "rotation": [0.0, 0.0, 0.0], "scale": [4.2, 1.4, 3.8]}};
  node_front_right_foot_14.userData.actionProfile = {"animationRole": "front_right_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_right_foot_14);
  nodes["front_right_foot"] = node_front_right_foot_14;
  const mesh_front_right_foot_14Geometry = endpoint_front_right_foot_14
    ? new THREE.CylinderGeometry(endpoint_front_right_foot_14.endRadius, endpoint_front_right_foot_14.baseRadius, endpoint_front_right_foot_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_right_foot_14 = new THREE.Mesh(
    mesh_front_right_foot_14Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_right_foot_14.name = "Front right webbed foot";
  if (endpoint_front_right_foot_14) {
    mesh_front_right_foot_14.position.copy(endpoint_front_right_foot_14.midpoint);
    mesh_front_right_foot_14.quaternion.copy(endpoint_front_right_foot_14.quaternion);
  }
  mesh_front_right_foot_14.castShadow = options.castShadow ?? true;
  mesh_front_right_foot_14.receiveShadow = options.receiveShadow ?? true;
  mesh_front_right_foot_14.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.8, "height": 1.4, "units": "Blockbench units", "width": 4.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_foot", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front right webbed foot", "parent": null, "primitive": "box", "role": "front right webbed foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 0.9, 4.8], "rotation": [0.0, 0.0, 0.0], "scale": [4.2, 1.4, 3.8]}};
  node_front_right_foot_14.add(mesh_front_right_foot_14);
  meshes["front_right_foot"] = mesh_front_right_foot_14;
  colliders["front_right_foot"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"};
  destructionGroups["front_right_foot"] ??= [];
  destructionGroups["front_right_foot"].push(node_front_right_foot_14);

  const attachment_front_right_toe_1_15 = null;
  const endpoint_front_right_toe_1_15 = makeAttachmentEndpoint(attachment_front_right_toe_1_15);
  const node_front_right_toe_1_15 = new THREE.Group();
  node_front_right_toe_1_15.name = "Front right outer toe__pivot";
  if (endpoint_front_right_toe_1_15) {
    node_front_right_toe_1_15.position.copy(endpoint_front_right_toe_1_15.start);
    node_front_right_toe_1_15.rotation.set(0, 0, 0);
    node_front_right_toe_1_15.scale.set(1, 1, 1);
  } else {
    node_front_right_toe_1_15.position.set(-4.95, 0.65, 6.5);
    node_front_right_toe_1_15.rotation.set(0.0, 0.0, 0.0);
    node_front_right_toe_1_15.scale.set(1.0, 0.8, 2.4);
  }
  node_front_right_toe_1_15.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_toe_1", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front right outer toe", "parent": null, "primitive": "box", "role": "front right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.95, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_right_toe_1_15.userData.actionProfile = {"animationRole": "front_right_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_right_toe_1_15);
  nodes["front_right_toe_1"] = node_front_right_toe_1_15;
  const mesh_front_right_toe_1_15Geometry = endpoint_front_right_toe_1_15
    ? new THREE.CylinderGeometry(endpoint_front_right_toe_1_15.endRadius, endpoint_front_right_toe_1_15.baseRadius, endpoint_front_right_toe_1_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_right_toe_1_15 = new THREE.Mesh(
    mesh_front_right_toe_1_15Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_right_toe_1_15.name = "Front right outer toe";
  if (endpoint_front_right_toe_1_15) {
    mesh_front_right_toe_1_15.position.copy(endpoint_front_right_toe_1_15.midpoint);
    mesh_front_right_toe_1_15.quaternion.copy(endpoint_front_right_toe_1_15.quaternion);
  }
  mesh_front_right_toe_1_15.castShadow = options.castShadow ?? true;
  mesh_front_right_toe_1_15.receiveShadow = options.receiveShadow ?? true;
  mesh_front_right_toe_1_15.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_toe_1", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front right outer toe", "parent": null, "primitive": "box", "role": "front right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.95, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_right_toe_1_15.add(mesh_front_right_toe_1_15);
  meshes["front_right_toe_1"] = mesh_front_right_toe_1_15;
  colliders["front_right_toe_1"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["front_right_toe_1"] ??= [];
  destructionGroups["front_right_toe_1"].push(node_front_right_toe_1_15);

  const attachment_front_right_toe_2_16 = null;
  const endpoint_front_right_toe_2_16 = makeAttachmentEndpoint(attachment_front_right_toe_2_16);
  const node_front_right_toe_2_16 = new THREE.Group();
  node_front_right_toe_2_16.name = "Front right middle toe__pivot";
  if (endpoint_front_right_toe_2_16) {
    node_front_right_toe_2_16.position.copy(endpoint_front_right_toe_2_16.start);
    node_front_right_toe_2_16.rotation.set(0, 0, 0);
    node_front_right_toe_2_16.scale.set(1, 1, 1);
  } else {
    node_front_right_toe_2_16.position.set(-3.7, 0.65, 6.5);
    node_front_right_toe_2_16.rotation.set(0.0, 0.0, 0.0);
    node_front_right_toe_2_16.scale.set(1.0, 0.8, 2.4);
  }
  node_front_right_toe_2_16.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_toe_2", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front right middle toe", "parent": null, "primitive": "box", "role": "front right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_right_toe_2_16.userData.actionProfile = {"animationRole": "front_right_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_right_toe_2_16);
  nodes["front_right_toe_2"] = node_front_right_toe_2_16;
  const mesh_front_right_toe_2_16Geometry = endpoint_front_right_toe_2_16
    ? new THREE.CylinderGeometry(endpoint_front_right_toe_2_16.endRadius, endpoint_front_right_toe_2_16.baseRadius, endpoint_front_right_toe_2_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_right_toe_2_16 = new THREE.Mesh(
    mesh_front_right_toe_2_16Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_right_toe_2_16.name = "Front right middle toe";
  if (endpoint_front_right_toe_2_16) {
    mesh_front_right_toe_2_16.position.copy(endpoint_front_right_toe_2_16.midpoint);
    mesh_front_right_toe_2_16.quaternion.copy(endpoint_front_right_toe_2_16.quaternion);
  }
  mesh_front_right_toe_2_16.castShadow = options.castShadow ?? true;
  mesh_front_right_toe_2_16.receiveShadow = options.receiveShadow ?? true;
  mesh_front_right_toe_2_16.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_toe_2", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front right middle toe", "parent": null, "primitive": "box", "role": "front right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_right_toe_2_16.add(mesh_front_right_toe_2_16);
  meshes["front_right_toe_2"] = mesh_front_right_toe_2_16;
  colliders["front_right_toe_2"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["front_right_toe_2"] ??= [];
  destructionGroups["front_right_toe_2"].push(node_front_right_toe_2_16);

  const attachment_front_right_toe_3_17 = null;
  const endpoint_front_right_toe_3_17 = makeAttachmentEndpoint(attachment_front_right_toe_3_17);
  const node_front_right_toe_3_17 = new THREE.Group();
  node_front_right_toe_3_17.name = "Front right inner toe__pivot";
  if (endpoint_front_right_toe_3_17) {
    node_front_right_toe_3_17.position.copy(endpoint_front_right_toe_3_17.start);
    node_front_right_toe_3_17.rotation.set(0, 0, 0);
    node_front_right_toe_3_17.scale.set(1, 1, 1);
  } else {
    node_front_right_toe_3_17.position.set(-2.45, 0.65, 6.5);
    node_front_right_toe_3_17.rotation.set(0.0, 0.0, 0.0);
    node_front_right_toe_3_17.scale.set(1.0, 0.8, 2.4);
  }
  node_front_right_toe_3_17.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_toe_3", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front right inner toe", "parent": null, "primitive": "box", "role": "front right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-2.45, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_right_toe_3_17.userData.actionProfile = {"animationRole": "front_right_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_front_right_toe_3_17);
  nodes["front_right_toe_3"] = node_front_right_toe_3_17;
  const mesh_front_right_toe_3_17Geometry = endpoint_front_right_toe_3_17
    ? new THREE.CylinderGeometry(endpoint_front_right_toe_3_17.endRadius, endpoint_front_right_toe_3_17.baseRadius, endpoint_front_right_toe_3_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_front_right_toe_3_17 = new THREE.Mesh(
    mesh_front_right_toe_3_17Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_right_toe_3_17.name = "Front right inner toe";
  if (endpoint_front_right_toe_3_17) {
    mesh_front_right_toe_3_17.position.copy(endpoint_front_right_toe_3_17.midpoint);
    mesh_front_right_toe_3_17.quaternion.copy(endpoint_front_right_toe_3_17.quaternion);
  }
  mesh_front_right_toe_3_17.castShadow = options.castShadow ?? true;
  mesh_front_right_toe_3_17.receiveShadow = options.receiveShadow ?? true;
  mesh_front_right_toe_3_17.userData.sculptComponent = {"actionProfile": {"animationRole": "front_right_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "front_right_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "front_right_toe_3", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Front right inner toe", "parent": null, "primitive": "box", "role": "front right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-2.45, 0.65, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_front_right_toe_3_17.add(mesh_front_right_toe_3_17);
  meshes["front_right_toe_3"] = mesh_front_right_toe_3_17;
  colliders["front_right_toe_3"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["front_right_toe_3"] ??= [];
  destructionGroups["front_right_toe_3"].push(node_front_right_toe_3_17);

  const attachment_rear_left_leg_18 = null;
  const endpoint_rear_left_leg_18 = makeAttachmentEndpoint(attachment_rear_left_leg_18);
  const node_rear_left_leg_18 = new THREE.Group();
  node_rear_left_leg_18.name = "Rear left leg__pivot";
  if (endpoint_rear_left_leg_18) {
    node_rear_left_leg_18.position.copy(endpoint_rear_left_leg_18.start);
    node_rear_left_leg_18.rotation.set(0, 0, 0);
    node_rear_left_leg_18.scale.set(1, 1, 1);
  } else {
    node_rear_left_leg_18.position.set(3.7, 3.8, -4.1);
    node_rear_left_leg_18.rotation.set(0.0, 0.0, 0.0);
    node_rear_left_leg_18.scale.set(2.5, 5.0, 2.7);
  }
  node_rear_left_leg_18.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "rear_left_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 36, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(36, 21, 14, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.7, "height": 5, "units": "Blockbench units", "width": 2.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_leg", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "fur_dark", "materialLayers": ["fur_dark"], "name": "Rear left leg", "parent": null, "primitive": "box", "role": "rear left leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 3.8, -4.1], "rotation": [0.0, 0.0, 0.0], "scale": [2.5, 5, 2.7]}};
  node_rear_left_leg_18.userData.actionProfile = {"animationRole": "rear_left_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "rear_left_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_left_leg_18);
  nodes["rear_left_leg"] = node_rear_left_leg_18;
  const mesh_rear_left_leg_18Geometry = endpoint_rear_left_leg_18
    ? new THREE.CylinderGeometry(endpoint_rear_left_leg_18.endRadius, endpoint_rear_left_leg_18.baseRadius, endpoint_rear_left_leg_18.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_left_leg_18 = new THREE.Mesh(
    mesh_rear_left_leg_18Geometry,
    materialMap["fur_dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_left_leg_18.name = "Rear left leg";
  if (endpoint_rear_left_leg_18) {
    mesh_rear_left_leg_18.position.copy(endpoint_rear_left_leg_18.midpoint);
    mesh_rear_left_leg_18.quaternion.copy(endpoint_rear_left_leg_18.quaternion);
  }
  mesh_rear_left_leg_18.castShadow = options.castShadow ?? true;
  mesh_rear_left_leg_18.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_left_leg_18.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "rear_left_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 36, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(36, 21, 14, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.7, "height": 5, "units": "Blockbench units", "width": 2.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_leg", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "fur_dark", "materialLayers": ["fur_dark"], "name": "Rear left leg", "parent": null, "primitive": "box", "role": "rear left leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 3.8, -4.1], "rotation": [0.0, 0.0, 0.0], "scale": [2.5, 5, 2.7]}};
  node_rear_left_leg_18.add(mesh_rear_left_leg_18);
  meshes["rear_left_leg"] = mesh_rear_left_leg_18;
  colliders["rear_left_leg"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"};
  destructionGroups["rear_left_leg"] ??= [];
  destructionGroups["rear_left_leg"].push(node_rear_left_leg_18);

  const attachment_rear_left_foot_19 = null;
  const endpoint_rear_left_foot_19 = makeAttachmentEndpoint(attachment_rear_left_foot_19);
  const node_rear_left_foot_19 = new THREE.Group();
  node_rear_left_foot_19.name = "Rear left webbed foot__pivot";
  if (endpoint_rear_left_foot_19) {
    node_rear_left_foot_19.position.copy(endpoint_rear_left_foot_19.start);
    node_rear_left_foot_19.rotation.set(0, 0, 0);
    node_rear_left_foot_19.scale.set(1, 1, 1);
  } else {
    node_rear_left_foot_19.position.set(3.7, 0.9, -3.5);
    node_rear_left_foot_19.rotation.set(0.0, 0.0, 0.0);
    node_rear_left_foot_19.scale.set(4.2, 1.4, 3.8);
  }
  node_rear_left_foot_19.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.8, "height": 1.4, "units": "Blockbench units", "width": 4.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_foot", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear left webbed foot", "parent": null, "primitive": "box", "role": "rear left webbed foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 0.9, -3.5], "rotation": [0.0, 0.0, 0.0], "scale": [4.2, 1.4, 3.8]}};
  node_rear_left_foot_19.userData.actionProfile = {"animationRole": "rear_left_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_left_foot_19);
  nodes["rear_left_foot"] = node_rear_left_foot_19;
  const mesh_rear_left_foot_19Geometry = endpoint_rear_left_foot_19
    ? new THREE.CylinderGeometry(endpoint_rear_left_foot_19.endRadius, endpoint_rear_left_foot_19.baseRadius, endpoint_rear_left_foot_19.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_left_foot_19 = new THREE.Mesh(
    mesh_rear_left_foot_19Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_left_foot_19.name = "Rear left webbed foot";
  if (endpoint_rear_left_foot_19) {
    mesh_rear_left_foot_19.position.copy(endpoint_rear_left_foot_19.midpoint);
    mesh_rear_left_foot_19.quaternion.copy(endpoint_rear_left_foot_19.quaternion);
  }
  mesh_rear_left_foot_19.castShadow = options.castShadow ?? true;
  mesh_rear_left_foot_19.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_left_foot_19.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.8, "height": 1.4, "units": "Blockbench units", "width": 4.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_foot", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear left webbed foot", "parent": null, "primitive": "box", "role": "rear left webbed foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 0.9, -3.5], "rotation": [0.0, 0.0, 0.0], "scale": [4.2, 1.4, 3.8]}};
  node_rear_left_foot_19.add(mesh_rear_left_foot_19);
  meshes["rear_left_foot"] = mesh_rear_left_foot_19;
  colliders["rear_left_foot"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"};
  destructionGroups["rear_left_foot"] ??= [];
  destructionGroups["rear_left_foot"].push(node_rear_left_foot_19);

  const attachment_rear_left_toe_1_20 = null;
  const endpoint_rear_left_toe_1_20 = makeAttachmentEndpoint(attachment_rear_left_toe_1_20);
  const node_rear_left_toe_1_20 = new THREE.Group();
  node_rear_left_toe_1_20.name = "Rear left outer toe__pivot";
  if (endpoint_rear_left_toe_1_20) {
    node_rear_left_toe_1_20.position.copy(endpoint_rear_left_toe_1_20.start);
    node_rear_left_toe_1_20.rotation.set(0, 0, 0);
    node_rear_left_toe_1_20.scale.set(1, 1, 1);
  } else {
    node_rear_left_toe_1_20.position.set(2.45, 0.65, -1.8);
    node_rear_left_toe_1_20.rotation.set(0.0, 0.0, 0.0);
    node_rear_left_toe_1_20.scale.set(1.0, 0.8, 2.4);
  }
  node_rear_left_toe_1_20.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_toe_1", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear left outer toe", "parent": null, "primitive": "box", "role": "rear left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [2.45, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_left_toe_1_20.userData.actionProfile = {"animationRole": "rear_left_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_left_toe_1_20);
  nodes["rear_left_toe_1"] = node_rear_left_toe_1_20;
  const mesh_rear_left_toe_1_20Geometry = endpoint_rear_left_toe_1_20
    ? new THREE.CylinderGeometry(endpoint_rear_left_toe_1_20.endRadius, endpoint_rear_left_toe_1_20.baseRadius, endpoint_rear_left_toe_1_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_left_toe_1_20 = new THREE.Mesh(
    mesh_rear_left_toe_1_20Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_left_toe_1_20.name = "Rear left outer toe";
  if (endpoint_rear_left_toe_1_20) {
    mesh_rear_left_toe_1_20.position.copy(endpoint_rear_left_toe_1_20.midpoint);
    mesh_rear_left_toe_1_20.quaternion.copy(endpoint_rear_left_toe_1_20.quaternion);
  }
  mesh_rear_left_toe_1_20.castShadow = options.castShadow ?? true;
  mesh_rear_left_toe_1_20.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_left_toe_1_20.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_toe_1", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear left outer toe", "parent": null, "primitive": "box", "role": "rear left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [2.45, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_left_toe_1_20.add(mesh_rear_left_toe_1_20);
  meshes["rear_left_toe_1"] = mesh_rear_left_toe_1_20;
  colliders["rear_left_toe_1"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["rear_left_toe_1"] ??= [];
  destructionGroups["rear_left_toe_1"].push(node_rear_left_toe_1_20);

  const attachment_rear_left_toe_2_21 = null;
  const endpoint_rear_left_toe_2_21 = makeAttachmentEndpoint(attachment_rear_left_toe_2_21);
  const node_rear_left_toe_2_21 = new THREE.Group();
  node_rear_left_toe_2_21.name = "Rear left middle toe__pivot";
  if (endpoint_rear_left_toe_2_21) {
    node_rear_left_toe_2_21.position.copy(endpoint_rear_left_toe_2_21.start);
    node_rear_left_toe_2_21.rotation.set(0, 0, 0);
    node_rear_left_toe_2_21.scale.set(1, 1, 1);
  } else {
    node_rear_left_toe_2_21.position.set(3.7, 0.65, -1.8);
    node_rear_left_toe_2_21.rotation.set(0.0, 0.0, 0.0);
    node_rear_left_toe_2_21.scale.set(1.0, 0.8, 2.4);
  }
  node_rear_left_toe_2_21.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["webbed-rear-feet"], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_toe_2", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": ["webbed-rear-feet"], "material": "web", "materialLayers": ["web"], "name": "Rear left middle toe", "parent": null, "primitive": "box", "role": "rear left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_left_toe_2_21.userData.actionProfile = {"animationRole": "rear_left_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_left_toe_2_21);
  nodes["rear_left_toe_2"] = node_rear_left_toe_2_21;
  const mesh_rear_left_toe_2_21Geometry = endpoint_rear_left_toe_2_21
    ? new THREE.CylinderGeometry(endpoint_rear_left_toe_2_21.endRadius, endpoint_rear_left_toe_2_21.baseRadius, endpoint_rear_left_toe_2_21.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_left_toe_2_21 = new THREE.Mesh(
    mesh_rear_left_toe_2_21Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_left_toe_2_21.name = "Rear left middle toe";
  if (endpoint_rear_left_toe_2_21) {
    mesh_rear_left_toe_2_21.position.copy(endpoint_rear_left_toe_2_21.midpoint);
    mesh_rear_left_toe_2_21.quaternion.copy(endpoint_rear_left_toe_2_21.quaternion);
  }
  mesh_rear_left_toe_2_21.castShadow = options.castShadow ?? true;
  mesh_rear_left_toe_2_21.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_left_toe_2_21.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["webbed-rear-feet"], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_toe_2", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": ["webbed-rear-feet"], "material": "web", "materialLayers": ["web"], "name": "Rear left middle toe", "parent": null, "primitive": "box", "role": "rear left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [3.7, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_left_toe_2_21.add(mesh_rear_left_toe_2_21);
  meshes["rear_left_toe_2"] = mesh_rear_left_toe_2_21;
  colliders["rear_left_toe_2"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["rear_left_toe_2"] ??= [];
  destructionGroups["rear_left_toe_2"].push(node_rear_left_toe_2_21);

  const attachment_rear_left_toe_3_22 = null;
  const endpoint_rear_left_toe_3_22 = makeAttachmentEndpoint(attachment_rear_left_toe_3_22);
  const node_rear_left_toe_3_22 = new THREE.Group();
  node_rear_left_toe_3_22.name = "Rear left inner toe__pivot";
  if (endpoint_rear_left_toe_3_22) {
    node_rear_left_toe_3_22.position.copy(endpoint_rear_left_toe_3_22.start);
    node_rear_left_toe_3_22.rotation.set(0, 0, 0);
    node_rear_left_toe_3_22.scale.set(1, 1, 1);
  } else {
    node_rear_left_toe_3_22.position.set(4.95, 0.65, -1.8);
    node_rear_left_toe_3_22.rotation.set(0.0, 0.0, 0.0);
    node_rear_left_toe_3_22.scale.set(1.0, 0.8, 2.4);
  }
  node_rear_left_toe_3_22.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_toe_3", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear left inner toe", "parent": null, "primitive": "box", "role": "rear left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.95, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_left_toe_3_22.userData.actionProfile = {"animationRole": "rear_left_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_left_toe_3_22);
  nodes["rear_left_toe_3"] = node_rear_left_toe_3_22;
  const mesh_rear_left_toe_3_22Geometry = endpoint_rear_left_toe_3_22
    ? new THREE.CylinderGeometry(endpoint_rear_left_toe_3_22.endRadius, endpoint_rear_left_toe_3_22.baseRadius, endpoint_rear_left_toe_3_22.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_left_toe_3_22 = new THREE.Mesh(
    mesh_rear_left_toe_3_22Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_left_toe_3_22.name = "Rear left inner toe";
  if (endpoint_rear_left_toe_3_22) {
    mesh_rear_left_toe_3_22.position.copy(endpoint_rear_left_toe_3_22.midpoint);
    mesh_rear_left_toe_3_22.quaternion.copy(endpoint_rear_left_toe_3_22.quaternion);
  }
  mesh_rear_left_toe_3_22.castShadow = options.castShadow ?? true;
  mesh_rear_left_toe_3_22.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_left_toe_3_22.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_left_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_left_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_left_toe_3", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear left inner toe", "parent": null, "primitive": "box", "role": "rear left toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.95, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_left_toe_3_22.add(mesh_rear_left_toe_3_22);
  meshes["rear_left_toe_3"] = mesh_rear_left_toe_3_22;
  colliders["rear_left_toe_3"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["rear_left_toe_3"] ??= [];
  destructionGroups["rear_left_toe_3"].push(node_rear_left_toe_3_22);

  const attachment_rear_right_leg_23 = null;
  const endpoint_rear_right_leg_23 = makeAttachmentEndpoint(attachment_rear_right_leg_23);
  const node_rear_right_leg_23 = new THREE.Group();
  node_rear_right_leg_23.name = "Rear right leg__pivot";
  if (endpoint_rear_right_leg_23) {
    node_rear_right_leg_23.position.copy(endpoint_rear_right_leg_23.start);
    node_rear_right_leg_23.rotation.set(0, 0, 0);
    node_rear_right_leg_23.scale.set(1, 1, 1);
  } else {
    node_rear_right_leg_23.position.set(-3.7, 3.8, -4.1);
    node_rear_right_leg_23.rotation.set(0.0, 0.0, 0.0);
    node_rear_right_leg_23.scale.set(2.5, 5.0, 2.7);
  }
  node_rear_right_leg_23.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "rear_right_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 36, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(36, 21, 14, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.7, "height": 5, "units": "Blockbench units", "width": 2.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_leg", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "fur_dark", "materialLayers": ["fur_dark"], "name": "Rear right leg", "parent": null, "primitive": "box", "role": "rear right leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 3.8, -4.1], "rotation": [0.0, 0.0, 0.0], "scale": [2.5, 5, 2.7]}};
  node_rear_right_leg_23.userData.actionProfile = {"animationRole": "rear_right_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "rear_right_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_right_leg_23);
  nodes["rear_right_leg"] = node_rear_right_leg_23;
  const mesh_rear_right_leg_23Geometry = endpoint_rear_right_leg_23
    ? new THREE.CylinderGeometry(endpoint_rear_right_leg_23.endRadius, endpoint_rear_right_leg_23.baseRadius, endpoint_rear_right_leg_23.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_right_leg_23 = new THREE.Mesh(
    mesh_rear_right_leg_23Geometry,
    materialMap["fur_dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_right_leg_23.name = "Rear right leg";
  if (endpoint_rear_right_leg_23) {
    mesh_rear_right_leg_23.position.copy(endpoint_rear_right_leg_23.midpoint);
    mesh_rear_right_leg_23.quaternion.copy(endpoint_rear_right_leg_23.quaternion);
  }
  mesh_rear_right_leg_23.castShadow = options.castShadow ?? true;
  mesh_rear_right_leg_23.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_right_leg_23.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_leg", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "fur_dark", "detachableFragments": [], "fractureGroup": "rear_right_leg", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 36, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(36, 21, 14, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.7, "height": 5, "units": "Blockbench units", "width": 2.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_leg", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "fur_dark", "materialLayers": ["fur_dark"], "name": "Rear right leg", "parent": null, "primitive": "box", "role": "rear right leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 3.8, -4.1], "rotation": [0.0, 0.0, 0.0], "scale": [2.5, 5, 2.7]}};
  node_rear_right_leg_23.add(mesh_rear_right_leg_23);
  meshes["rear_right_leg"] = mesh_rear_right_leg_23;
  colliders["rear_right_leg"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.5, 5, 2.7], "type": "box"};
  destructionGroups["rear_right_leg"] ??= [];
  destructionGroups["rear_right_leg"].push(node_rear_right_leg_23);

  const attachment_rear_right_foot_24 = null;
  const endpoint_rear_right_foot_24 = makeAttachmentEndpoint(attachment_rear_right_foot_24);
  const node_rear_right_foot_24 = new THREE.Group();
  node_rear_right_foot_24.name = "Rear right webbed foot__pivot";
  if (endpoint_rear_right_foot_24) {
    node_rear_right_foot_24.position.copy(endpoint_rear_right_foot_24.start);
    node_rear_right_foot_24.rotation.set(0, 0, 0);
    node_rear_right_foot_24.scale.set(1, 1, 1);
  } else {
    node_rear_right_foot_24.position.set(-3.7, 0.9, -3.5);
    node_rear_right_foot_24.rotation.set(0.0, 0.0, 0.0);
    node_rear_right_foot_24.scale.set(4.2, 1.4, 3.8);
  }
  node_rear_right_foot_24.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.8, "height": 1.4, "units": "Blockbench units", "width": 4.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_foot", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear right webbed foot", "parent": null, "primitive": "box", "role": "rear right webbed foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 0.9, -3.5], "rotation": [0.0, 0.0, 0.0], "scale": [4.2, 1.4, 3.8]}};
  node_rear_right_foot_24.userData.actionProfile = {"animationRole": "rear_right_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_right_foot_24);
  nodes["rear_right_foot"] = node_rear_right_foot_24;
  const mesh_rear_right_foot_24Geometry = endpoint_rear_right_foot_24
    ? new THREE.CylinderGeometry(endpoint_rear_right_foot_24.endRadius, endpoint_rear_right_foot_24.baseRadius, endpoint_rear_right_foot_24.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_right_foot_24 = new THREE.Mesh(
    mesh_rear_right_foot_24Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_right_foot_24.name = "Rear right webbed foot";
  if (endpoint_rear_right_foot_24) {
    mesh_rear_right_foot_24.position.copy(endpoint_rear_right_foot_24.midpoint);
    mesh_rear_right_foot_24.quaternion.copy(endpoint_rear_right_foot_24.quaternion);
  }
  mesh_rear_right_foot_24.castShadow = options.castShadow ?? true;
  mesh_rear_right_foot_24.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_right_foot_24.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_foot", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_foot", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.8, "height": 1.4, "units": "Blockbench units", "width": 4.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_foot", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear right webbed foot", "parent": null, "primitive": "box", "role": "rear right webbed foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 0.9, -3.5], "rotation": [0.0, 0.0, 0.0], "scale": [4.2, 1.4, 3.8]}};
  node_rear_right_foot_24.add(mesh_rear_right_foot_24);
  meshes["rear_right_foot"] = mesh_rear_right_foot_24;
  colliders["rear_right_foot"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.2, 1.4, 3.8], "type": "box"};
  destructionGroups["rear_right_foot"] ??= [];
  destructionGroups["rear_right_foot"].push(node_rear_right_foot_24);

  const attachment_rear_right_toe_1_25 = null;
  const endpoint_rear_right_toe_1_25 = makeAttachmentEndpoint(attachment_rear_right_toe_1_25);
  const node_rear_right_toe_1_25 = new THREE.Group();
  node_rear_right_toe_1_25.name = "Rear right outer toe__pivot";
  if (endpoint_rear_right_toe_1_25) {
    node_rear_right_toe_1_25.position.copy(endpoint_rear_right_toe_1_25.start);
    node_rear_right_toe_1_25.rotation.set(0, 0, 0);
    node_rear_right_toe_1_25.scale.set(1, 1, 1);
  } else {
    node_rear_right_toe_1_25.position.set(-4.95, 0.65, -1.8);
    node_rear_right_toe_1_25.rotation.set(0.0, 0.0, 0.0);
    node_rear_right_toe_1_25.scale.set(1.0, 0.8, 2.4);
  }
  node_rear_right_toe_1_25.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_toe_1", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear right outer toe", "parent": null, "primitive": "box", "role": "rear right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.95, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_right_toe_1_25.userData.actionProfile = {"animationRole": "rear_right_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_right_toe_1_25);
  nodes["rear_right_toe_1"] = node_rear_right_toe_1_25;
  const mesh_rear_right_toe_1_25Geometry = endpoint_rear_right_toe_1_25
    ? new THREE.CylinderGeometry(endpoint_rear_right_toe_1_25.endRadius, endpoint_rear_right_toe_1_25.baseRadius, endpoint_rear_right_toe_1_25.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_right_toe_1_25 = new THREE.Mesh(
    mesh_rear_right_toe_1_25Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_right_toe_1_25.name = "Rear right outer toe";
  if (endpoint_rear_right_toe_1_25) {
    mesh_rear_right_toe_1_25.position.copy(endpoint_rear_right_toe_1_25.midpoint);
    mesh_rear_right_toe_1_25.quaternion.copy(endpoint_rear_right_toe_1_25.quaternion);
  }
  mesh_rear_right_toe_1_25.castShadow = options.castShadow ?? true;
  mesh_rear_right_toe_1_25.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_right_toe_1_25.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_toe_1", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_1", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_toe_1", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear right outer toe", "parent": null, "primitive": "box", "role": "rear right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.95, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_right_toe_1_25.add(mesh_rear_right_toe_1_25);
  meshes["rear_right_toe_1"] = mesh_rear_right_toe_1_25;
  colliders["rear_right_toe_1"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["rear_right_toe_1"] ??= [];
  destructionGroups["rear_right_toe_1"].push(node_rear_right_toe_1_25);

  const attachment_rear_right_toe_2_26 = null;
  const endpoint_rear_right_toe_2_26 = makeAttachmentEndpoint(attachment_rear_right_toe_2_26);
  const node_rear_right_toe_2_26 = new THREE.Group();
  node_rear_right_toe_2_26.name = "Rear right middle toe__pivot";
  if (endpoint_rear_right_toe_2_26) {
    node_rear_right_toe_2_26.position.copy(endpoint_rear_right_toe_2_26.start);
    node_rear_right_toe_2_26.rotation.set(0, 0, 0);
    node_rear_right_toe_2_26.scale.set(1, 1, 1);
  } else {
    node_rear_right_toe_2_26.position.set(-3.7, 0.65, -1.8);
    node_rear_right_toe_2_26.rotation.set(0.0, 0.0, 0.0);
    node_rear_right_toe_2_26.scale.set(1.0, 0.8, 2.4);
  }
  node_rear_right_toe_2_26.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_toe_2", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear right middle toe", "parent": null, "primitive": "box", "role": "rear right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_right_toe_2_26.userData.actionProfile = {"animationRole": "rear_right_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_right_toe_2_26);
  nodes["rear_right_toe_2"] = node_rear_right_toe_2_26;
  const mesh_rear_right_toe_2_26Geometry = endpoint_rear_right_toe_2_26
    ? new THREE.CylinderGeometry(endpoint_rear_right_toe_2_26.endRadius, endpoint_rear_right_toe_2_26.baseRadius, endpoint_rear_right_toe_2_26.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_right_toe_2_26 = new THREE.Mesh(
    mesh_rear_right_toe_2_26Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_right_toe_2_26.name = "Rear right middle toe";
  if (endpoint_rear_right_toe_2_26) {
    mesh_rear_right_toe_2_26.position.copy(endpoint_rear_right_toe_2_26.midpoint);
    mesh_rear_right_toe_2_26.quaternion.copy(endpoint_rear_right_toe_2_26.quaternion);
  }
  mesh_rear_right_toe_2_26.castShadow = options.castShadow ?? true;
  mesh_rear_right_toe_2_26.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_right_toe_2_26.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_toe_2", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_2", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_toe_2", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear right middle toe", "parent": null, "primitive": "box", "role": "rear right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-3.7, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_right_toe_2_26.add(mesh_rear_right_toe_2_26);
  meshes["rear_right_toe_2"] = mesh_rear_right_toe_2_26;
  colliders["rear_right_toe_2"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["rear_right_toe_2"] ??= [];
  destructionGroups["rear_right_toe_2"].push(node_rear_right_toe_2_26);

  const attachment_rear_right_toe_3_27 = null;
  const endpoint_rear_right_toe_3_27 = makeAttachmentEndpoint(attachment_rear_right_toe_3_27);
  const node_rear_right_toe_3_27 = new THREE.Group();
  node_rear_right_toe_3_27.name = "Rear right inner toe__pivot";
  if (endpoint_rear_right_toe_3_27) {
    node_rear_right_toe_3_27.position.copy(endpoint_rear_right_toe_3_27.start);
    node_rear_right_toe_3_27.rotation.set(0, 0, 0);
    node_rear_right_toe_3_27.scale.set(1, 1, 1);
  } else {
    node_rear_right_toe_3_27.position.set(-2.45, 0.65, -1.8);
    node_rear_right_toe_3_27.rotation.set(0.0, 0.0, 0.0);
    node_rear_right_toe_3_27.scale.set(1.0, 0.8, 2.4);
  }
  node_rear_right_toe_3_27.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_toe_3", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear right inner toe", "parent": null, "primitive": "box", "role": "rear right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-2.45, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_right_toe_3_27.userData.actionProfile = {"animationRole": "rear_right_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_rear_right_toe_3_27);
  nodes["rear_right_toe_3"] = node_rear_right_toe_3_27;
  const mesh_rear_right_toe_3_27Geometry = endpoint_rear_right_toe_3_27
    ? new THREE.CylinderGeometry(endpoint_rear_right_toe_3_27.endRadius, endpoint_rear_right_toe_3_27.baseRadius, endpoint_rear_right_toe_3_27.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_rear_right_toe_3_27 = new THREE.Mesh(
    mesh_rear_right_toe_3_27Geometry,
    materialMap["web"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_right_toe_3_27.name = "Rear right inner toe";
  if (endpoint_rear_right_toe_3_27) {
    mesh_rear_right_toe_3_27.position.copy(endpoint_rear_right_toe_3_27.midpoint);
    mesh_rear_right_toe_3_27.quaternion.copy(endpoint_rear_right_toe_3_27.quaternion);
  }
  mesh_rear_right_toe_3_27.castShadow = options.castShadow ?? true;
  mesh_rear_right_toe_3_27.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_right_toe_3_27.userData.sculptComponent = {"actionProfile": {"animationRole": "rear_right_toe_3", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "web", "detachableFragments": [], "fractureGroup": "rear_right_toe_3", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(70, 81, 93, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(41, 51, 61, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 2.4, "height": 0.8, "units": "Blockbench units", "width": 1}, "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "rear_right_toe_3", "importance": 0.58, "joints": [], "level": "micro", "localFeatures": [], "material": "web", "materialLayers": ["web"], "name": "Rear right inner toe", "parent": null, "primitive": "box", "role": "rear right toe", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-2.45, 0.65, -1.8], "rotation": [0.0, 0.0, 0.0], "scale": [1, 0.8, 2.4]}};
  node_rear_right_toe_3_27.add(mesh_rear_right_toe_3_27);
  meshes["rear_right_toe_3"] = mesh_rear_right_toe_3_27;
  colliders["rear_right_toe_3"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1, 0.8, 2.4], "type": "box"};
  destructionGroups["rear_right_toe_3"] ??= [];
  destructionGroups["rear_right_toe_3"].push(node_rear_right_toe_3_27);

  // repetition system: paired-limbs-and-toes (InstancedMesh, radial, count=20, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 20);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 20; i++) {
      const ang = ((0.0) + (i * 360) / 20) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "paired-limbs-and-toes";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"lightingPass": {"mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"], "requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"]}, "materialPass": {"albedoPaletteRequired": true, "geometryReliefRequiredWhenSilhouetteAffected": true, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "localOverridesRequired": true, "minimumTextureResolution": 256, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"], "normalOrBumpRequired": true, "preferredTextureResolution": 256, "referencePbrExtraction": {"acceptedLimitation": "The Minecraft BBModel target preserves albedo only. Reference pixels are baked into cuboid faces by the img2blockbench adapter; Three.js PBR maps remain preview-only.", "requiredWhenSourceImagePresent": false, "stopOnLowConfidence": false, "targetThreshold": 0.7}, "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "roughnessVariationRequired": true}, "qualityPriority": "reference-fidelity", "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createMinecraftPlatypusLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Minecraft Platypus look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["Warm key light from upper left with soft shadows.", "Cool neutral fill light from camera right.", "Soft environment rim light separates the dark tail and feet.", "Filmic tone mapping at neutral exposure.", "Subtle ground contact shadow beneath all four feet."];
  lights.userData.lookDevTargets = {"lightingPass": {"mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"], "requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"]}, "materialPass": {"albedoPaletteRequired": true, "geometryReliefRequiredWhenSilhouetteAffected": true, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "localOverridesRequired": true, "minimumTextureResolution": 256, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"], "normalOrBumpRequired": true, "preferredTextureResolution": 256, "referencePbrExtraction": {"acceptedLimitation": "The Minecraft BBModel target preserves albedo only. Reference pixels are baked into cuboid faces by the img2blockbench adapter; Three.js PBR maps remain preview-only.", "requiredWhenSourceImagePresent": false, "stopOnLowConfidence": false, "targetThreshold": 0.7}, "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "roughnessVariationRequired": true}, "qualityPriority": "reference-fidelity", "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createMinecraftPlatypusEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameMinecraftPlatypusCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createMinecraftPlatypusPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureMinecraftPlatypusRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createMinecraftPlatypusInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
