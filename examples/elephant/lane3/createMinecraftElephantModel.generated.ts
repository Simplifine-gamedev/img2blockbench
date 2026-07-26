import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

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

// Generated from ObjectSculptSpec target: Minecraft Elephant
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createMinecraftElephantModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Minecraft Elephant";

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["gray_hide"] = createSculptMaterial(
    "gray_hide",
    {"albedo": {"dominant": "#666565", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#414142", "#858382"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#666565", "color": "#666565", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#666565", "#414142", "#858382"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#414142"}, "id": "gray_hide", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "gray_hide-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Gray Hide", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.88, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["dark_gray"] = createSculptMaterial(
    "dark_gray",
    {"albedo": {"dominant": "#4b4a4b", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#303033", "#696769"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#4b4a4b", "color": "#4b4a4b", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#4b4a4b", "#303033", "#696769"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#303033"}, "id": "dark_gray", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "dark_gray-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Dark Gray", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.9, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["ear_inner"] = createSculptMaterial(
    "ear_inner",
    {"albedo": {"dominant": "#8f765f", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#67513f", "#ad9278"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#8f765f", "color": "#8f765f", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#8f765f", "#67513f", "#ad9278"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#67513f"}, "id": "ear_inner", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "ear_inner-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Ear Inner", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.84, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["ivory"] = createSculptMaterial(
    "ivory",
    {"albedo": {"dominant": "#ead4b6", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#bda78c", "#fff0d3"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#ead4b6", "color": "#ead4b6", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#ead4b6", "#bda78c", "#fff0d3"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#bda78c"}, "id": "ivory", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "ivory-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Ivory", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.62, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["feet_gray"] = createSculptMaterial(
    "feet_gray",
    {"albedo": {"dominant": "#555455", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#353538", "#777577"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#555455", "color": "#555455", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#555455", "#353538", "#777577"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#353538"}, "id": "feet_gray", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "feet_gray-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Feet Gray", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.9, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["tail_dark"] = createSculptMaterial(
    "tail_dark",
    {"albedo": {"dominant": "#39383a", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#222225", "#575659"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#39383a", "color": "#39383a", "colorVariation": {"amplitude": 0.12, "heightCorrelation": 0.16, "palette": ["#39383a", "#222225", "#575659"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#222225"}, "id": "tail_dark", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "tail_dark-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Tail Dark", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.92, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );
  materialMap["eye"] = createSculptMaterial(
    "eye",
    {"albedo": {"dominant": "#101010", "samplingNotes": "Palette sampled from the Minecraft-style reference.", "secondary": ["#020202", "#2a2928"]}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.25}, "baseColor": "#101010", "color": "#101010", "colorVariation": {"amplitude": 0.02, "heightCorrelation": 0.16, "palette": ["#101010", "#020202", "#2a2928"], "pattern": "blocky mottled pixels"}, "dirt": {"amount": 0.02, "cavityBias": 0.25, "color": "#020202"}, "id": "eye", "localOverrides": [{"description": "Reference-matched square-pixel color variation.", "evidenceRefs": ["full-object"], "id": "eye-pixel-variation"}], "metalness": {"base": 0.0, "variation": 0.0}, "name": "Eye", "normal": {"pattern": "independent-height-field", "scale": 12.0, "strength": 0.12}, "roughness": {"base": 0.28, "map": "independent-procedural-field", "variation": 0.08}, "shaderModel": "MeshPhysicalMaterial", "shaderNotes": ["Keep the material matte and readable under neutral turntable lighting.", "Use nearest-looking color steps rather than smooth organic noise."], "surfaceFrequencyBands": [{"amplitude": 0.18, "frequency": 2.0, "id": "macro", "role": "broad color zones"}, {"amplitude": 0.09, "frequency": 8.0, "id": "meso", "role": "pixel mottling"}, {"amplitude": 0.025, "frequency": 24.0, "id": "micro", "role": "subtle highlight breakup"}], "textureProjection": {"anisotropy": 4, "mode": "uv", "repeat": [3.0, 3.0], "texelDensityIntent": "Crisp low-resolution material variation."}, "textureResolution": 256, "type": "standard", "wear": {"chips": [], "edgeWear": 0.02, "scratches": []}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_body_0 = null;
  const endpoint_body_0 = makeAttachmentEndpoint(attachment_body_0);
  const node_body_0 = new THREE.Group();
  node_body_0.name = "Body__pivot";
  if (endpoint_body_0) {
    node_body_0.position.copy(endpoint_body_0.start);
    node_body_0.rotation.set(0, 0, 0);
    node_body_0.scale.set(1, 1, 1);
  } else {
    node_body_0.position.set(0.0, 10.2, 0.0);
    node_body_0.rotation.set(0.0, 0.0, 0.0);
    node_body_0.scale.set(12.4, 9.2, 14.4);
  }
  node_body_0.userData.sculptComponent = {"actionProfile": {"animationRole": "body", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [12.4, 9.2, 14.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "body", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 14.4, "height": 9.2, "units": "Blockbench units", "width": 12.4}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "body", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Body", "parent": null, "primitive": "box", "role": "massive elephant torso", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 10.2, 0], "rotation": [0.0, 0.0, 0.0], "scale": [12.4, 9.2, 14.4]}};
  node_body_0.userData.actionProfile = {"animationRole": "body", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [12.4, 9.2, 14.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "body", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_body_0);
  nodes["body"] = node_body_0;
  const mesh_body_0Geometry = endpoint_body_0
    ? new THREE.CylinderGeometry(endpoint_body_0.endRadius, endpoint_body_0.baseRadius, endpoint_body_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_body_0 = new THREE.Mesh(
    mesh_body_0Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_0.name = "Body";
  if (endpoint_body_0) {
    mesh_body_0.position.copy(endpoint_body_0.midpoint);
    mesh_body_0.quaternion.copy(endpoint_body_0.quaternion);
  }
  mesh_body_0.castShadow = options.castShadow ?? true;
  mesh_body_0.receiveShadow = options.receiveShadow ?? true;
  mesh_body_0.userData.sculptComponent = {"actionProfile": {"animationRole": "body", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [12.4, 9.2, 14.4], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "body", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 14.4, "height": 9.2, "units": "Blockbench units", "width": 12.4}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "body", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Body", "parent": null, "primitive": "box", "role": "massive elephant torso", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 10.2, 0], "rotation": [0.0, 0.0, 0.0], "scale": [12.4, 9.2, 14.4]}};
  node_body_0.add(mesh_body_0);
  meshes["body"] = mesh_body_0;
  colliders["body"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [12.4, 9.2, 14.4], "type": "box"};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_body_0);

  const attachment_shoulders_1 = null;
  const endpoint_shoulders_1 = makeAttachmentEndpoint(attachment_shoulders_1);
  const node_shoulders_1 = new THREE.Group();
  node_shoulders_1.name = "Shoulders__pivot";
  if (endpoint_shoulders_1) {
    node_shoulders_1.position.copy(endpoint_shoulders_1.start);
    node_shoulders_1.rotation.set(0, 0, 0);
    node_shoulders_1.scale.set(1, 1, 1);
  } else {
    node_shoulders_1.position.set(0.0, 10.7, 4.8);
    node_shoulders_1.rotation.set(0.0, 0.0, 0.0);
    node_shoulders_1.scale.set(12.8, 9.8, 5.2);
  }
  node_shoulders_1.userData.sculptComponent = {"actionProfile": {"animationRole": "shoulders", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [12.8, 9.8, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "shoulders", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 5.2, "height": 9.8, "units": "Blockbench units", "width": 12.8}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "shoulders", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Shoulders", "parent": null, "primitive": "box", "role": "high shoulder mass", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 10.7, 4.8], "rotation": [0.0, 0.0, 0.0], "scale": [12.8, 9.8, 5.2]}};
  node_shoulders_1.userData.actionProfile = {"animationRole": "shoulders", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [12.8, 9.8, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "shoulders", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_shoulders_1);
  nodes["shoulders"] = node_shoulders_1;
  const mesh_shoulders_1Geometry = endpoint_shoulders_1
    ? new THREE.CylinderGeometry(endpoint_shoulders_1.endRadius, endpoint_shoulders_1.baseRadius, endpoint_shoulders_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_shoulders_1 = new THREE.Mesh(
    mesh_shoulders_1Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulders_1.name = "Shoulders";
  if (endpoint_shoulders_1) {
    mesh_shoulders_1.position.copy(endpoint_shoulders_1.midpoint);
    mesh_shoulders_1.quaternion.copy(endpoint_shoulders_1.quaternion);
  }
  mesh_shoulders_1.castShadow = options.castShadow ?? true;
  mesh_shoulders_1.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulders_1.userData.sculptComponent = {"actionProfile": {"animationRole": "shoulders", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [12.8, 9.8, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "shoulders", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 5.2, "height": 9.8, "units": "Blockbench units", "width": 12.8}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "shoulders", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Shoulders", "parent": null, "primitive": "box", "role": "high shoulder mass", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 10.7, 4.8], "rotation": [0.0, 0.0, 0.0], "scale": [12.8, 9.8, 5.2]}};
  node_shoulders_1.add(mesh_shoulders_1);
  meshes["shoulders"] = mesh_shoulders_1;
  colliders["shoulders"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [12.8, 9.8, 5.2], "type": "box"};
  destructionGroups["shoulders"] ??= [];
  destructionGroups["shoulders"].push(node_shoulders_1);

  const attachment_neck_2 = null;
  const endpoint_neck_2 = makeAttachmentEndpoint(attachment_neck_2);
  const node_neck_2 = new THREE.Group();
  node_neck_2.name = "Neck__pivot";
  if (endpoint_neck_2) {
    node_neck_2.position.copy(endpoint_neck_2.start);
    node_neck_2.rotation.set(0, 0, 0);
    node_neck_2.scale.set(1, 1, 1);
  } else {
    node_neck_2.position.set(0.0, 11.7, 6.5);
    node_neck_2.rotation.set(0.0, 0.0, 0.0);
    node_neck_2.scale.set(8.2, 8.2, 4.2);
  }
  node_neck_2.userData.sculptComponent = {"actionProfile": {"animationRole": "neck", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8.2, 8.2, 4.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "neck", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(75, 74, 75, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 48, 51, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.2, "height": 8.2, "units": "Blockbench units", "width": 8.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "neck", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "dark_gray", "materialLayers": ["dark_gray"], "name": "Neck", "parent": null, "primitive": "box", "role": "short thick neck", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 11.7, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [8.2, 8.2, 4.2]}};
  node_neck_2.userData.actionProfile = {"animationRole": "neck", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8.2, 8.2, 4.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "neck", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_neck_2);
  nodes["neck"] = node_neck_2;
  const mesh_neck_2Geometry = endpoint_neck_2
    ? new THREE.CylinderGeometry(endpoint_neck_2.endRadius, endpoint_neck_2.baseRadius, endpoint_neck_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_neck_2 = new THREE.Mesh(
    mesh_neck_2Geometry,
    materialMap["dark_gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_neck_2.name = "Neck";
  if (endpoint_neck_2) {
    mesh_neck_2.position.copy(endpoint_neck_2.midpoint);
    mesh_neck_2.quaternion.copy(endpoint_neck_2.quaternion);
  }
  mesh_neck_2.castShadow = options.castShadow ?? true;
  mesh_neck_2.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_2.userData.sculptComponent = {"actionProfile": {"animationRole": "neck", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [8.2, 8.2, 4.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "neck", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(75, 74, 75, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 48, 51, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.2, "height": 8.2, "units": "Blockbench units", "width": 8.2}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "neck", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "dark_gray", "materialLayers": ["dark_gray"], "name": "Neck", "parent": null, "primitive": "box", "role": "short thick neck", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 11.7, 6.5], "rotation": [0.0, 0.0, 0.0], "scale": [8.2, 8.2, 4.2]}};
  node_neck_2.add(mesh_neck_2);
  meshes["neck"] = mesh_neck_2;
  colliders["neck"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [8.2, 8.2, 4.2], "type": "box"};
  destructionGroups["neck"] ??= [];
  destructionGroups["neck"].push(node_neck_2);

  const attachment_head_3 = null;
  const endpoint_head_3 = makeAttachmentEndpoint(attachment_head_3);
  const node_head_3 = new THREE.Group();
  node_head_3.name = "Head__pivot";
  if (endpoint_head_3) {
    node_head_3.position.copy(endpoint_head_3.start);
    node_head_3.rotation.set(0, 0, 0);
    node_head_3.scale.set(1, 1, 1);
  } else {
    node_head_3.position.set(0.0, 12.2, 9.7);
    node_head_3.rotation.set(0.0, 0.0, 0.0);
    node_head_3.scale.set(9.2, 9.2, 8.2);
  }
  node_head_3.userData.sculptComponent = {"actionProfile": {"animationRole": "head", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [9.2, 9.2, 8.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "head", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 8.2, "height": 9.2, "units": "Blockbench units", "width": 9.2}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "head", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Head", "parent": null, "primitive": "box", "role": "large elephant head", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 12.2, 9.7], "rotation": [0.0, 0.0, 0.0], "scale": [9.2, 9.2, 8.2]}};
  node_head_3.userData.actionProfile = {"animationRole": "head", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [9.2, 9.2, 8.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "head", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_head_3);
  nodes["head"] = node_head_3;
  const mesh_head_3Geometry = endpoint_head_3
    ? new THREE.CylinderGeometry(endpoint_head_3.endRadius, endpoint_head_3.baseRadius, endpoint_head_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_head_3 = new THREE.Mesh(
    mesh_head_3Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_3.name = "Head";
  if (endpoint_head_3) {
    mesh_head_3.position.copy(endpoint_head_3.midpoint);
    mesh_head_3.quaternion.copy(endpoint_head_3.quaternion);
  }
  mesh_head_3.castShadow = options.castShadow ?? true;
  mesh_head_3.receiveShadow = options.receiveShadow ?? true;
  mesh_head_3.userData.sculptComponent = {"actionProfile": {"animationRole": "head", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [9.2, 9.2, 8.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "head", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 8.2, "height": 9.2, "units": "Blockbench units", "width": 9.2}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "head", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Head", "parent": null, "primitive": "box", "role": "large elephant head", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 12.2, 9.7], "rotation": [0.0, 0.0, 0.0], "scale": [9.2, 9.2, 8.2]}};
  node_head_3.add(mesh_head_3);
  meshes["head"] = mesh_head_3;
  colliders["head"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [9.2, 9.2, 8.2], "type": "box"};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_3);

  const attachment_ear_left_4 = null;
  const endpoint_ear_left_4 = makeAttachmentEndpoint(attachment_ear_left_4);
  const node_ear_left_4 = new THREE.Group();
  node_ear_left_4.name = "Left ear__pivot";
  if (endpoint_ear_left_4) {
    node_ear_left_4.position.copy(endpoint_ear_left_4.start);
    node_ear_left_4.rotation.set(0, 0, 0);
    node_ear_left_4.scale.set(1, 1, 1);
  } else {
    node_ear_left_4.position.set(5.25, 12.7, 8.3);
    node_ear_left_4.rotation.set(0.0, -0.08726646259971647, -0.05235987755982989);
    node_ear_left_4.scale.set(6.2, 10.2, 2.0);
  }
  node_ear_left_4.userData.sculptComponent = {"actionProfile": {"animationRole": "ear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [6.2, 10.2, 2.0], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "ear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["broad-ears", "mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 2.0, "height": 10.2, "units": "Blockbench units", "width": 6.2}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "ear_left", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["broad-ears", "mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Left ear", "parent": null, "primitive": "box", "role": "broad left ear", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [5.25, 12.7, 8.3], "rotation": [0.0, -0.08726646259971647, -0.05235987755982989], "scale": [6.2, 10.2, 2.0]}};
  node_ear_left_4.userData.actionProfile = {"animationRole": "ear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [6.2, 10.2, 2.0], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "ear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_ear_left_4);
  nodes["ear_left"] = node_ear_left_4;
  const mesh_ear_left_4Geometry = endpoint_ear_left_4
    ? new THREE.CylinderGeometry(endpoint_ear_left_4.endRadius, endpoint_ear_left_4.baseRadius, endpoint_ear_left_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_ear_left_4 = new THREE.Mesh(
    mesh_ear_left_4Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_left_4.name = "Left ear";
  if (endpoint_ear_left_4) {
    mesh_ear_left_4.position.copy(endpoint_ear_left_4.midpoint);
    mesh_ear_left_4.quaternion.copy(endpoint_ear_left_4.quaternion);
  }
  mesh_ear_left_4.castShadow = options.castShadow ?? true;
  mesh_ear_left_4.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_left_4.userData.sculptComponent = {"actionProfile": {"animationRole": "ear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [6.2, 10.2, 2.0], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "ear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["broad-ears", "mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 2.0, "height": 10.2, "units": "Blockbench units", "width": 6.2}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "ear_left", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["broad-ears", "mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Left ear", "parent": null, "primitive": "box", "role": "broad left ear", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [5.25, 12.7, 8.3], "rotation": [0.0, -0.08726646259971647, -0.05235987755982989], "scale": [6.2, 10.2, 2.0]}};
  node_ear_left_4.add(mesh_ear_left_4);
  meshes["ear_left"] = mesh_ear_left_4;
  colliders["ear_left"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [6.2, 10.2, 2.0], "type": "box"};
  destructionGroups["ear_left"] ??= [];
  destructionGroups["ear_left"].push(node_ear_left_4);

  const attachment_ear_right_5 = null;
  const endpoint_ear_right_5 = makeAttachmentEndpoint(attachment_ear_right_5);
  const node_ear_right_5 = new THREE.Group();
  node_ear_right_5.name = "Right ear__pivot";
  if (endpoint_ear_right_5) {
    node_ear_right_5.position.copy(endpoint_ear_right_5.start);
    node_ear_right_5.rotation.set(0, 0, 0);
    node_ear_right_5.scale.set(1, 1, 1);
  } else {
    node_ear_right_5.position.set(-5.25, 12.7, 8.3);
    node_ear_right_5.rotation.set(0.0, 0.08726646259971647, 0.05235987755982989);
    node_ear_right_5.scale.set(6.2, 10.2, 2.0);
  }
  node_ear_right_5.userData.sculptComponent = {"actionProfile": {"animationRole": "ear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [6.2, 10.2, 2.0], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "ear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 2.0, "height": 10.2, "units": "Blockbench units", "width": 6.2}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "ear_right", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Right ear", "parent": null, "primitive": "box", "role": "broad right ear", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-5.25, 12.7, 8.3], "rotation": [0.0, 0.08726646259971647, 0.05235987755982989], "scale": [6.2, 10.2, 2.0]}};
  node_ear_right_5.userData.actionProfile = {"animationRole": "ear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [6.2, 10.2, 2.0], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "ear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_ear_right_5);
  nodes["ear_right"] = node_ear_right_5;
  const mesh_ear_right_5Geometry = endpoint_ear_right_5
    ? new THREE.CylinderGeometry(endpoint_ear_right_5.endRadius, endpoint_ear_right_5.baseRadius, endpoint_ear_right_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_ear_right_5 = new THREE.Mesh(
    mesh_ear_right_5Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_right_5.name = "Right ear";
  if (endpoint_ear_right_5) {
    mesh_ear_right_5.position.copy(endpoint_ear_right_5.midpoint);
    mesh_ear_right_5.quaternion.copy(endpoint_ear_right_5.quaternion);
  }
  mesh_ear_right_5.castShadow = options.castShadow ?? true;
  mesh_ear_right_5.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_right_5.userData.sculptComponent = {"actionProfile": {"animationRole": "ear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [6.2, 10.2, 2.0], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "ear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 2.0, "height": 10.2, "units": "Blockbench units", "width": 6.2}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "ear_right", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Right ear", "parent": null, "primitive": "box", "role": "broad right ear", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-5.25, 12.7, 8.3], "rotation": [0.0, 0.08726646259971647, 0.05235987755982989], "scale": [6.2, 10.2, 2.0]}};
  node_ear_right_5.add(mesh_ear_right_5);
  meshes["ear_right"] = mesh_ear_right_5;
  colliders["ear_right"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [6.2, 10.2, 2.0], "type": "box"};
  destructionGroups["ear_right"] ??= [];
  destructionGroups["ear_right"].push(node_ear_right_5);

  const attachment_trunk_base_6 = null;
  const endpoint_trunk_base_6 = makeAttachmentEndpoint(attachment_trunk_base_6);
  const node_trunk_base_6 = new THREE.Group();
  node_trunk_base_6.name = "Trunk base__pivot";
  if (endpoint_trunk_base_6) {
    node_trunk_base_6.position.copy(endpoint_trunk_base_6.start);
    node_trunk_base_6.rotation.set(0, 0, 0);
    node_trunk_base_6.scale.set(1, 1, 1);
  } else {
    node_trunk_base_6.position.set(0.0, 9.5, 13.25);
    node_trunk_base_6.rotation.set(0.08726646259971647, 0.0, 0.0);
    node_trunk_base_6.scale.set(4.3, 6.2, 4.1);
  }
  node_trunk_base_6.userData.sculptComponent = {"actionProfile": {"animationRole": "trunk_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.3, 6.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "trunk_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(75, 74, 75, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 48, 51, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["segmented-trunk"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 6.2, "units": "Blockbench units", "width": 4.3}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "trunk_base", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["segmented-trunk"], "material": "dark_gray", "materialLayers": ["dark_gray"], "name": "Trunk base", "parent": null, "primitive": "box", "role": "upper hanging trunk", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 9.5, 13.25], "rotation": [0.08726646259971647, 0.0, 0.0], "scale": [4.3, 6.2, 4.1]}};
  node_trunk_base_6.userData.actionProfile = {"animationRole": "trunk_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.3, 6.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "trunk_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_trunk_base_6);
  nodes["trunk_base"] = node_trunk_base_6;
  const mesh_trunk_base_6Geometry = endpoint_trunk_base_6
    ? new THREE.CylinderGeometry(endpoint_trunk_base_6.endRadius, endpoint_trunk_base_6.baseRadius, endpoint_trunk_base_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_trunk_base_6 = new THREE.Mesh(
    mesh_trunk_base_6Geometry,
    materialMap["dark_gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_trunk_base_6.name = "Trunk base";
  if (endpoint_trunk_base_6) {
    mesh_trunk_base_6.position.copy(endpoint_trunk_base_6.midpoint);
    mesh_trunk_base_6.quaternion.copy(endpoint_trunk_base_6.quaternion);
  }
  mesh_trunk_base_6.castShadow = options.castShadow ?? true;
  mesh_trunk_base_6.receiveShadow = options.receiveShadow ?? true;
  mesh_trunk_base_6.userData.sculptComponent = {"actionProfile": {"animationRole": "trunk_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.3, 6.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "trunk_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(75, 74, 75, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 48, 51, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["segmented-trunk"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 6.2, "units": "Blockbench units", "width": 4.3}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "trunk_base", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["segmented-trunk"], "material": "dark_gray", "materialLayers": ["dark_gray"], "name": "Trunk base", "parent": null, "primitive": "box", "role": "upper hanging trunk", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 9.5, 13.25], "rotation": [0.08726646259971647, 0.0, 0.0], "scale": [4.3, 6.2, 4.1]}};
  node_trunk_base_6.add(mesh_trunk_base_6);
  meshes["trunk_base"] = mesh_trunk_base_6;
  colliders["trunk_base"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.3, 6.2, 4.1], "type": "box"};
  destructionGroups["trunk_base"] ??= [];
  destructionGroups["trunk_base"].push(node_trunk_base_6);

  const attachment_trunk_mid_7 = null;
  const endpoint_trunk_mid_7 = makeAttachmentEndpoint(attachment_trunk_mid_7);
  const node_trunk_mid_7 = new THREE.Group();
  node_trunk_mid_7.name = "Trunk middle__pivot";
  if (endpoint_trunk_mid_7) {
    node_trunk_mid_7.position.copy(endpoint_trunk_mid_7.start);
    node_trunk_mid_7.rotation.set(0, 0, 0);
    node_trunk_mid_7.scale.set(1, 1, 1);
  } else {
    node_trunk_mid_7.position.set(0.0, 5.8, 14.2);
    node_trunk_mid_7.rotation.set(0.15707963267948966, 0.0, 0.0);
    node_trunk_mid_7.scale.set(3.7, 5.1, 3.6);
  }
  node_trunk_mid_7.userData.sculptComponent = {"actionProfile": {"animationRole": "trunk_mid", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [3.7, 5.1, 3.6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "trunk_mid", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 3.6, "height": 5.1, "units": "Blockbench units", "width": 3.7}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "trunk_mid", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Trunk middle", "parent": null, "primitive": "box", "role": "middle hanging trunk", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 5.8, 14.2], "rotation": [0.15707963267948966, 0.0, 0.0], "scale": [3.7, 5.1, 3.6]}};
  node_trunk_mid_7.userData.actionProfile = {"animationRole": "trunk_mid", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [3.7, 5.1, 3.6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "trunk_mid", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_trunk_mid_7);
  nodes["trunk_mid"] = node_trunk_mid_7;
  const mesh_trunk_mid_7Geometry = endpoint_trunk_mid_7
    ? new THREE.CylinderGeometry(endpoint_trunk_mid_7.endRadius, endpoint_trunk_mid_7.baseRadius, endpoint_trunk_mid_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_trunk_mid_7 = new THREE.Mesh(
    mesh_trunk_mid_7Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_trunk_mid_7.name = "Trunk middle";
  if (endpoint_trunk_mid_7) {
    mesh_trunk_mid_7.position.copy(endpoint_trunk_mid_7.midpoint);
    mesh_trunk_mid_7.quaternion.copy(endpoint_trunk_mid_7.quaternion);
  }
  mesh_trunk_mid_7.castShadow = options.castShadow ?? true;
  mesh_trunk_mid_7.receiveShadow = options.receiveShadow ?? true;
  mesh_trunk_mid_7.userData.sculptComponent = {"actionProfile": {"animationRole": "trunk_mid", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [3.7, 5.1, 3.6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "trunk_mid", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 3.6, "height": 5.1, "units": "Blockbench units", "width": 3.7}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "trunk_mid", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Trunk middle", "parent": null, "primitive": "box", "role": "middle hanging trunk", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 5.8, 14.2], "rotation": [0.15707963267948966, 0.0, 0.0], "scale": [3.7, 5.1, 3.6]}};
  node_trunk_mid_7.add(mesh_trunk_mid_7);
  meshes["trunk_mid"] = mesh_trunk_mid_7;
  colliders["trunk_mid"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [3.7, 5.1, 3.6], "type": "box"};
  destructionGroups["trunk_mid"] ??= [];
  destructionGroups["trunk_mid"].push(node_trunk_mid_7);

  const attachment_trunk_tip_8 = null;
  const endpoint_trunk_tip_8 = makeAttachmentEndpoint(attachment_trunk_tip_8);
  const node_trunk_tip_8 = new THREE.Group();
  node_trunk_tip_8.name = "Trunk tip__pivot";
  if (endpoint_trunk_tip_8) {
    node_trunk_tip_8.position.copy(endpoint_trunk_tip_8.start);
    node_trunk_tip_8.rotation.set(0, 0, 0);
    node_trunk_tip_8.scale.set(1, 1, 1);
  } else {
    node_trunk_tip_8.position.set(0.0, 2.75, 14.9);
    node_trunk_tip_8.rotation.set(0.22689280275926285, 0.0, 0.0);
    node_trunk_tip_8.scale.set(3.3, 3.6, 3.1);
  }
  node_trunk_tip_8.userData.sculptComponent = {"actionProfile": {"animationRole": "trunk_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [3.3, 3.6, 3.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "trunk_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(75, 74, 75, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 48, 51, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.1, "height": 3.6, "units": "Blockbench units", "width": 3.3}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "trunk_tip", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "dark_gray", "materialLayers": ["dark_gray"], "name": "Trunk tip", "parent": null, "primitive": "box", "role": "curved trunk tip", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 2.75, 14.9], "rotation": [0.22689280275926285, 0.0, 0.0], "scale": [3.3, 3.6, 3.1]}};
  node_trunk_tip_8.userData.actionProfile = {"animationRole": "trunk_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [3.3, 3.6, 3.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "trunk_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_trunk_tip_8);
  nodes["trunk_tip"] = node_trunk_tip_8;
  const mesh_trunk_tip_8Geometry = endpoint_trunk_tip_8
    ? new THREE.CylinderGeometry(endpoint_trunk_tip_8.endRadius, endpoint_trunk_tip_8.baseRadius, endpoint_trunk_tip_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_trunk_tip_8 = new THREE.Mesh(
    mesh_trunk_tip_8Geometry,
    materialMap["dark_gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_trunk_tip_8.name = "Trunk tip";
  if (endpoint_trunk_tip_8) {
    mesh_trunk_tip_8.position.copy(endpoint_trunk_tip_8.midpoint);
    mesh_trunk_tip_8.quaternion.copy(endpoint_trunk_tip_8.quaternion);
  }
  mesh_trunk_tip_8.castShadow = options.castShadow ?? true;
  mesh_trunk_tip_8.receiveShadow = options.receiveShadow ?? true;
  mesh_trunk_tip_8.userData.sculptComponent = {"actionProfile": {"animationRole": "trunk_tip", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [3.3, 3.6, 3.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "trunk_tip", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(75, 74, 75, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 48, 51, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 3.1, "height": 3.6, "units": "Blockbench units", "width": 3.3}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "trunk_tip", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "dark_gray", "materialLayers": ["dark_gray"], "name": "Trunk tip", "parent": null, "primitive": "box", "role": "curved trunk tip", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 2.75, 14.9], "rotation": [0.22689280275926285, 0.0, 0.0], "scale": [3.3, 3.6, 3.1]}};
  node_trunk_tip_8.add(mesh_trunk_tip_8);
  meshes["trunk_tip"] = mesh_trunk_tip_8;
  colliders["trunk_tip"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [3.3, 3.6, 3.1], "type": "box"};
  destructionGroups["trunk_tip"] ??= [];
  destructionGroups["trunk_tip"].push(node_trunk_tip_8);

  const attachment_tusk_left_9 = null;
  const endpoint_tusk_left_9 = makeAttachmentEndpoint(attachment_tusk_left_9);
  const node_tusk_left_9 = new THREE.Group();
  node_tusk_left_9.name = "Left tusk__pivot";
  if (endpoint_tusk_left_9) {
    node_tusk_left_9.position.copy(endpoint_tusk_left_9.start);
    node_tusk_left_9.rotation.set(0, 0, 0);
    node_tusk_left_9.scale.set(1, 1, 1);
  } else {
    node_tusk_left_9.position.set(2.75, 8.25, 14.3);
    node_tusk_left_9.rotation.set(-0.29670597283903605, -0.10471975511965978, 0.0);
    node_tusk_left_9.scale.set(1.25, 1.25, 5.2);
  }
  node_tusk_left_9.userData.sculptComponent = {"actionProfile": {"animationRole": "tusk_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.25, 1.25, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "ivory", "detachableFragments": [], "fractureGroup": "tusk_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 212, 182, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(189, 167, 140, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["ivory-tusks"], "dimensions": {"confidence": 0.9, "depth": 5.2, "height": 1.25, "units": "Blockbench units", "width": 1.25}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tusk_left", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["ivory-tusks"], "material": "ivory", "materialLayers": ["ivory"], "name": "Left tusk", "parent": null, "primitive": "box", "role": "forward ivory left tusk", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [2.75, 8.25, 14.3], "rotation": [-0.29670597283903605, -0.10471975511965978, 0.0], "scale": [1.25, 1.25, 5.2]}};
  node_tusk_left_9.userData.actionProfile = {"animationRole": "tusk_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.25, 1.25, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "ivory", "detachableFragments": [], "fractureGroup": "tusk_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_tusk_left_9);
  nodes["tusk_left"] = node_tusk_left_9;
  const mesh_tusk_left_9Geometry = endpoint_tusk_left_9
    ? new THREE.CylinderGeometry(endpoint_tusk_left_9.endRadius, endpoint_tusk_left_9.baseRadius, endpoint_tusk_left_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tusk_left_9 = new THREE.Mesh(
    mesh_tusk_left_9Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tusk_left_9.name = "Left tusk";
  if (endpoint_tusk_left_9) {
    mesh_tusk_left_9.position.copy(endpoint_tusk_left_9.midpoint);
    mesh_tusk_left_9.quaternion.copy(endpoint_tusk_left_9.quaternion);
  }
  mesh_tusk_left_9.castShadow = options.castShadow ?? true;
  mesh_tusk_left_9.receiveShadow = options.receiveShadow ?? true;
  mesh_tusk_left_9.userData.sculptComponent = {"actionProfile": {"animationRole": "tusk_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.25, 1.25, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "ivory", "detachableFragments": [], "fractureGroup": "tusk_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 212, 182, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(189, 167, 140, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["ivory-tusks"], "dimensions": {"confidence": 0.9, "depth": 5.2, "height": 1.25, "units": "Blockbench units", "width": 1.25}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tusk_left", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["ivory-tusks"], "material": "ivory", "materialLayers": ["ivory"], "name": "Left tusk", "parent": null, "primitive": "box", "role": "forward ivory left tusk", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [2.75, 8.25, 14.3], "rotation": [-0.29670597283903605, -0.10471975511965978, 0.0], "scale": [1.25, 1.25, 5.2]}};
  node_tusk_left_9.add(mesh_tusk_left_9);
  meshes["tusk_left"] = mesh_tusk_left_9;
  colliders["tusk_left"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.25, 1.25, 5.2], "type": "box"};
  destructionGroups["tusk_left"] ??= [];
  destructionGroups["tusk_left"].push(node_tusk_left_9);

  const attachment_tusk_right_10 = null;
  const endpoint_tusk_right_10 = makeAttachmentEndpoint(attachment_tusk_right_10);
  const node_tusk_right_10 = new THREE.Group();
  node_tusk_right_10.name = "Right tusk__pivot";
  if (endpoint_tusk_right_10) {
    node_tusk_right_10.position.copy(endpoint_tusk_right_10.start);
    node_tusk_right_10.rotation.set(0, 0, 0);
    node_tusk_right_10.scale.set(1, 1, 1);
  } else {
    node_tusk_right_10.position.set(-2.75, 8.25, 14.3);
    node_tusk_right_10.rotation.set(-0.29670597283903605, 0.10471975511965978, 0.0);
    node_tusk_right_10.scale.set(1.25, 1.25, 5.2);
  }
  node_tusk_right_10.userData.sculptComponent = {"actionProfile": {"animationRole": "tusk_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.25, 1.25, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "ivory", "detachableFragments": [], "fractureGroup": "tusk_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 212, 182, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(189, 167, 140, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 5.2, "height": 1.25, "units": "Blockbench units", "width": 1.25}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tusk_right", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "ivory", "materialLayers": ["ivory"], "name": "Right tusk", "parent": null, "primitive": "box", "role": "forward ivory right tusk", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-2.75, 8.25, 14.3], "rotation": [-0.29670597283903605, 0.10471975511965978, 0.0], "scale": [1.25, 1.25, 5.2]}};
  node_tusk_right_10.userData.actionProfile = {"animationRole": "tusk_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.25, 1.25, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "ivory", "detachableFragments": [], "fractureGroup": "tusk_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_tusk_right_10);
  nodes["tusk_right"] = node_tusk_right_10;
  const mesh_tusk_right_10Geometry = endpoint_tusk_right_10
    ? new THREE.CylinderGeometry(endpoint_tusk_right_10.endRadius, endpoint_tusk_right_10.baseRadius, endpoint_tusk_right_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tusk_right_10 = new THREE.Mesh(
    mesh_tusk_right_10Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tusk_right_10.name = "Right tusk";
  if (endpoint_tusk_right_10) {
    mesh_tusk_right_10.position.copy(endpoint_tusk_right_10.midpoint);
    mesh_tusk_right_10.quaternion.copy(endpoint_tusk_right_10.quaternion);
  }
  mesh_tusk_right_10.castShadow = options.castShadow ?? true;
  mesh_tusk_right_10.receiveShadow = options.receiveShadow ?? true;
  mesh_tusk_right_10.userData.sculptComponent = {"actionProfile": {"animationRole": "tusk_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.25, 1.25, 5.2], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "ivory", "detachableFragments": [], "fractureGroup": "tusk_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 212, 182, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(189, 167, 140, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 5.2, "height": 1.25, "units": "Blockbench units", "width": 1.25}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tusk_right", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "ivory", "materialLayers": ["ivory"], "name": "Right tusk", "parent": null, "primitive": "box", "role": "forward ivory right tusk", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-2.75, 8.25, 14.3], "rotation": [-0.29670597283903605, 0.10471975511965978, 0.0], "scale": [1.25, 1.25, 5.2]}};
  node_tusk_right_10.add(mesh_tusk_right_10);
  meshes["tusk_right"] = mesh_tusk_right_10;
  colliders["tusk_right"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.25, 1.25, 5.2], "type": "box"};
  destructionGroups["tusk_right"] ??= [];
  destructionGroups["tusk_right"].push(node_tusk_right_10);

  const attachment_leg_front_left_11 = null;
  const endpoint_leg_front_left_11 = makeAttachmentEndpoint(attachment_leg_front_left_11);
  const node_leg_front_left_11 = new THREE.Group();
  node_leg_front_left_11.name = "Front left leg__pivot";
  if (endpoint_leg_front_left_11) {
    node_leg_front_left_11.position.copy(endpoint_leg_front_left_11.start);
    node_leg_front_left_11.rotation.set(0, 0, 0);
    node_leg_front_left_11.scale.set(1, 1, 1);
  } else {
    node_leg_front_left_11.position.set(4.1, 4.45, 4.7);
    node_leg_front_left_11.rotation.set(0.0, 0.0, 0.0);
    node_leg_front_left_11.scale.set(4.1, 8.2, 4.1);
  }
  node_leg_front_left_11.userData.sculptComponent = {"actionProfile": {"animationRole": "leg_front_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_front_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["pillar-legs", "mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 8.2, "units": "Blockbench units", "width": 4.1}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "leg_front_left", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["pillar-legs", "mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Front left leg", "parent": null, "primitive": "box", "role": "front left pillar leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.1, 4.45, 4.7], "rotation": [0.0, 0.0, 0.0], "scale": [4.1, 8.2, 4.1]}};
  node_leg_front_left_11.userData.actionProfile = {"animationRole": "leg_front_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_front_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_leg_front_left_11);
  nodes["leg_front_left"] = node_leg_front_left_11;
  const mesh_leg_front_left_11Geometry = endpoint_leg_front_left_11
    ? new THREE.CylinderGeometry(endpoint_leg_front_left_11.endRadius, endpoint_leg_front_left_11.baseRadius, endpoint_leg_front_left_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_leg_front_left_11 = new THREE.Mesh(
    mesh_leg_front_left_11Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_front_left_11.name = "Front left leg";
  if (endpoint_leg_front_left_11) {
    mesh_leg_front_left_11.position.copy(endpoint_leg_front_left_11.midpoint);
    mesh_leg_front_left_11.quaternion.copy(endpoint_leg_front_left_11.quaternion);
  }
  mesh_leg_front_left_11.castShadow = options.castShadow ?? true;
  mesh_leg_front_left_11.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_front_left_11.userData.sculptComponent = {"actionProfile": {"animationRole": "leg_front_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_front_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["pillar-legs", "mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 8.2, "units": "Blockbench units", "width": 4.1}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "leg_front_left", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["pillar-legs", "mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Front left leg", "parent": null, "primitive": "box", "role": "front left pillar leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.1, 4.45, 4.7], "rotation": [0.0, 0.0, 0.0], "scale": [4.1, 8.2, 4.1]}};
  node_leg_front_left_11.add(mesh_leg_front_left_11);
  meshes["leg_front_left"] = mesh_leg_front_left_11;
  colliders["leg_front_left"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"};
  destructionGroups["leg_front_left"] ??= [];
  destructionGroups["leg_front_left"].push(node_leg_front_left_11);

  const attachment_foot_front_left_12 = null;
  const endpoint_foot_front_left_12 = makeAttachmentEndpoint(attachment_foot_front_left_12);
  const node_foot_front_left_12 = new THREE.Group();
  node_foot_front_left_12.name = "Front left foot__pivot";
  if (endpoint_foot_front_left_12) {
    node_foot_front_left_12.position.copy(endpoint_foot_front_left_12.start);
    node_foot_front_left_12.rotation.set(0, 0, 0);
    node_foot_front_left_12.scale.set(1, 1, 1);
  } else {
    node_foot_front_left_12.position.set(4.1, 0.85, 5.1);
    node_foot_front_left_12.rotation.set(0.0, 0.0, 0.0);
    node_foot_front_left_12.scale.set(4.6, 1.7, 4.9);
  }
  node_foot_front_left_12.userData.sculptComponent = {"actionProfile": {"animationRole": "foot_front_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_front_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 84, 85, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(53, 53, 56, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.9, "height": 1.7, "units": "Blockbench units", "width": 4.6}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "foot_front_left", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "feet_gray", "materialLayers": ["feet_gray"], "name": "Front left foot", "parent": null, "primitive": "box", "role": "front left broad foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.1, 0.85, 5.1], "rotation": [0.0, 0.0, 0.0], "scale": [4.6, 1.7, 4.9]}};
  node_foot_front_left_12.userData.actionProfile = {"animationRole": "foot_front_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_front_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_foot_front_left_12);
  nodes["foot_front_left"] = node_foot_front_left_12;
  const mesh_foot_front_left_12Geometry = endpoint_foot_front_left_12
    ? new THREE.CylinderGeometry(endpoint_foot_front_left_12.endRadius, endpoint_foot_front_left_12.baseRadius, endpoint_foot_front_left_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_foot_front_left_12 = new THREE.Mesh(
    mesh_foot_front_left_12Geometry,
    materialMap["feet_gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_front_left_12.name = "Front left foot";
  if (endpoint_foot_front_left_12) {
    mesh_foot_front_left_12.position.copy(endpoint_foot_front_left_12.midpoint);
    mesh_foot_front_left_12.quaternion.copy(endpoint_foot_front_left_12.quaternion);
  }
  mesh_foot_front_left_12.castShadow = options.castShadow ?? true;
  mesh_foot_front_left_12.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_front_left_12.userData.sculptComponent = {"actionProfile": {"animationRole": "foot_front_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_front_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 84, 85, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(53, 53, 56, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.9, "height": 1.7, "units": "Blockbench units", "width": 4.6}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "foot_front_left", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "feet_gray", "materialLayers": ["feet_gray"], "name": "Front left foot", "parent": null, "primitive": "box", "role": "front left broad foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.1, 0.85, 5.1], "rotation": [0.0, 0.0, 0.0], "scale": [4.6, 1.7, 4.9]}};
  node_foot_front_left_12.add(mesh_foot_front_left_12);
  meshes["foot_front_left"] = mesh_foot_front_left_12;
  colliders["foot_front_left"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"};
  destructionGroups["foot_front_left"] ??= [];
  destructionGroups["foot_front_left"].push(node_foot_front_left_12);

  const attachment_leg_front_right_13 = null;
  const endpoint_leg_front_right_13 = makeAttachmentEndpoint(attachment_leg_front_right_13);
  const node_leg_front_right_13 = new THREE.Group();
  node_leg_front_right_13.name = "Front right leg__pivot";
  if (endpoint_leg_front_right_13) {
    node_leg_front_right_13.position.copy(endpoint_leg_front_right_13.start);
    node_leg_front_right_13.rotation.set(0, 0, 0);
    node_leg_front_right_13.scale.set(1, 1, 1);
  } else {
    node_leg_front_right_13.position.set(-4.1, 4.45, 4.7);
    node_leg_front_right_13.rotation.set(0.0, 0.0, 0.0);
    node_leg_front_right_13.scale.set(4.1, 8.2, 4.1);
  }
  node_leg_front_right_13.userData.sculptComponent = {"actionProfile": {"animationRole": "leg_front_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_front_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 8.2, "units": "Blockbench units", "width": 4.1}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "leg_front_right", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Front right leg", "parent": null, "primitive": "box", "role": "front right pillar leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.1, 4.45, 4.7], "rotation": [0.0, 0.0, 0.0], "scale": [4.1, 8.2, 4.1]}};
  node_leg_front_right_13.userData.actionProfile = {"animationRole": "leg_front_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_front_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_leg_front_right_13);
  nodes["leg_front_right"] = node_leg_front_right_13;
  const mesh_leg_front_right_13Geometry = endpoint_leg_front_right_13
    ? new THREE.CylinderGeometry(endpoint_leg_front_right_13.endRadius, endpoint_leg_front_right_13.baseRadius, endpoint_leg_front_right_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_leg_front_right_13 = new THREE.Mesh(
    mesh_leg_front_right_13Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_front_right_13.name = "Front right leg";
  if (endpoint_leg_front_right_13) {
    mesh_leg_front_right_13.position.copy(endpoint_leg_front_right_13.midpoint);
    mesh_leg_front_right_13.quaternion.copy(endpoint_leg_front_right_13.quaternion);
  }
  mesh_leg_front_right_13.castShadow = options.castShadow ?? true;
  mesh_leg_front_right_13.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_front_right_13.userData.sculptComponent = {"actionProfile": {"animationRole": "leg_front_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_front_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 8.2, "units": "Blockbench units", "width": 4.1}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "leg_front_right", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Front right leg", "parent": null, "primitive": "box", "role": "front right pillar leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.1, 4.45, 4.7], "rotation": [0.0, 0.0, 0.0], "scale": [4.1, 8.2, 4.1]}};
  node_leg_front_right_13.add(mesh_leg_front_right_13);
  meshes["leg_front_right"] = mesh_leg_front_right_13;
  colliders["leg_front_right"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"};
  destructionGroups["leg_front_right"] ??= [];
  destructionGroups["leg_front_right"].push(node_leg_front_right_13);

  const attachment_foot_front_right_14 = null;
  const endpoint_foot_front_right_14 = makeAttachmentEndpoint(attachment_foot_front_right_14);
  const node_foot_front_right_14 = new THREE.Group();
  node_foot_front_right_14.name = "Front right foot__pivot";
  if (endpoint_foot_front_right_14) {
    node_foot_front_right_14.position.copy(endpoint_foot_front_right_14.start);
    node_foot_front_right_14.rotation.set(0, 0, 0);
    node_foot_front_right_14.scale.set(1, 1, 1);
  } else {
    node_foot_front_right_14.position.set(-4.1, 0.85, 5.1);
    node_foot_front_right_14.rotation.set(0.0, 0.0, 0.0);
    node_foot_front_right_14.scale.set(4.6, 1.7, 4.9);
  }
  node_foot_front_right_14.userData.sculptComponent = {"actionProfile": {"animationRole": "foot_front_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_front_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 84, 85, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(53, 53, 56, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.9, "height": 1.7, "units": "Blockbench units", "width": 4.6}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "foot_front_right", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "feet_gray", "materialLayers": ["feet_gray"], "name": "Front right foot", "parent": null, "primitive": "box", "role": "front right broad foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.1, 0.85, 5.1], "rotation": [0.0, 0.0, 0.0], "scale": [4.6, 1.7, 4.9]}};
  node_foot_front_right_14.userData.actionProfile = {"animationRole": "foot_front_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_front_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_foot_front_right_14);
  nodes["foot_front_right"] = node_foot_front_right_14;
  const mesh_foot_front_right_14Geometry = endpoint_foot_front_right_14
    ? new THREE.CylinderGeometry(endpoint_foot_front_right_14.endRadius, endpoint_foot_front_right_14.baseRadius, endpoint_foot_front_right_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_foot_front_right_14 = new THREE.Mesh(
    mesh_foot_front_right_14Geometry,
    materialMap["feet_gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_front_right_14.name = "Front right foot";
  if (endpoint_foot_front_right_14) {
    mesh_foot_front_right_14.position.copy(endpoint_foot_front_right_14.midpoint);
    mesh_foot_front_right_14.quaternion.copy(endpoint_foot_front_right_14.quaternion);
  }
  mesh_foot_front_right_14.castShadow = options.castShadow ?? true;
  mesh_foot_front_right_14.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_front_right_14.userData.sculptComponent = {"actionProfile": {"animationRole": "foot_front_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_front_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 84, 85, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(53, 53, 56, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.9, "height": 1.7, "units": "Blockbench units", "width": 4.6}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "foot_front_right", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "feet_gray", "materialLayers": ["feet_gray"], "name": "Front right foot", "parent": null, "primitive": "box", "role": "front right broad foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.1, 0.85, 5.1], "rotation": [0.0, 0.0, 0.0], "scale": [4.6, 1.7, 4.9]}};
  node_foot_front_right_14.add(mesh_foot_front_right_14);
  meshes["foot_front_right"] = mesh_foot_front_right_14;
  colliders["foot_front_right"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"};
  destructionGroups["foot_front_right"] ??= [];
  destructionGroups["foot_front_right"].push(node_foot_front_right_14);

  const attachment_leg_rear_left_15 = null;
  const endpoint_leg_rear_left_15 = makeAttachmentEndpoint(attachment_leg_rear_left_15);
  const node_leg_rear_left_15 = new THREE.Group();
  node_leg_rear_left_15.name = "Rear left leg__pivot";
  if (endpoint_leg_rear_left_15) {
    node_leg_rear_left_15.position.copy(endpoint_leg_rear_left_15.start);
    node_leg_rear_left_15.rotation.set(0, 0, 0);
    node_leg_rear_left_15.scale.set(1, 1, 1);
  } else {
    node_leg_rear_left_15.position.set(4.1, 4.45, -4.6);
    node_leg_rear_left_15.rotation.set(0.0, 0.0, 0.0);
    node_leg_rear_left_15.scale.set(4.1, 8.2, 4.1);
  }
  node_leg_rear_left_15.userData.sculptComponent = {"actionProfile": {"animationRole": "leg_rear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_rear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 8.2, "units": "Blockbench units", "width": 4.1}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "leg_rear_left", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Rear left leg", "parent": null, "primitive": "box", "role": "rear left pillar leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.1, 4.45, -4.6], "rotation": [0.0, 0.0, 0.0], "scale": [4.1, 8.2, 4.1]}};
  node_leg_rear_left_15.userData.actionProfile = {"animationRole": "leg_rear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_rear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_leg_rear_left_15);
  nodes["leg_rear_left"] = node_leg_rear_left_15;
  const mesh_leg_rear_left_15Geometry = endpoint_leg_rear_left_15
    ? new THREE.CylinderGeometry(endpoint_leg_rear_left_15.endRadius, endpoint_leg_rear_left_15.baseRadius, endpoint_leg_rear_left_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_leg_rear_left_15 = new THREE.Mesh(
    mesh_leg_rear_left_15Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_rear_left_15.name = "Rear left leg";
  if (endpoint_leg_rear_left_15) {
    mesh_leg_rear_left_15.position.copy(endpoint_leg_rear_left_15.midpoint);
    mesh_leg_rear_left_15.quaternion.copy(endpoint_leg_rear_left_15.quaternion);
  }
  mesh_leg_rear_left_15.castShadow = options.castShadow ?? true;
  mesh_leg_rear_left_15.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_rear_left_15.userData.sculptComponent = {"actionProfile": {"animationRole": "leg_rear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_rear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 8.2, "units": "Blockbench units", "width": 4.1}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "leg_rear_left", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Rear left leg", "parent": null, "primitive": "box", "role": "rear left pillar leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.1, 4.45, -4.6], "rotation": [0.0, 0.0, 0.0], "scale": [4.1, 8.2, 4.1]}};
  node_leg_rear_left_15.add(mesh_leg_rear_left_15);
  meshes["leg_rear_left"] = mesh_leg_rear_left_15;
  colliders["leg_rear_left"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"};
  destructionGroups["leg_rear_left"] ??= [];
  destructionGroups["leg_rear_left"].push(node_leg_rear_left_15);

  const attachment_foot_rear_left_16 = null;
  const endpoint_foot_rear_left_16 = makeAttachmentEndpoint(attachment_foot_rear_left_16);
  const node_foot_rear_left_16 = new THREE.Group();
  node_foot_rear_left_16.name = "Rear left foot__pivot";
  if (endpoint_foot_rear_left_16) {
    node_foot_rear_left_16.position.copy(endpoint_foot_rear_left_16.start);
    node_foot_rear_left_16.rotation.set(0, 0, 0);
    node_foot_rear_left_16.scale.set(1, 1, 1);
  } else {
    node_foot_rear_left_16.position.set(4.1, 0.85, -4.2);
    node_foot_rear_left_16.rotation.set(0.0, 0.0, 0.0);
    node_foot_rear_left_16.scale.set(4.6, 1.7, 4.9);
  }
  node_foot_rear_left_16.userData.sculptComponent = {"actionProfile": {"animationRole": "foot_rear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_rear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 84, 85, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(53, 53, 56, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.9, "height": 1.7, "units": "Blockbench units", "width": 4.6}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "foot_rear_left", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "feet_gray", "materialLayers": ["feet_gray"], "name": "Rear left foot", "parent": null, "primitive": "box", "role": "rear left broad foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.1, 0.85, -4.2], "rotation": [0.0, 0.0, 0.0], "scale": [4.6, 1.7, 4.9]}};
  node_foot_rear_left_16.userData.actionProfile = {"animationRole": "foot_rear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_rear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_foot_rear_left_16);
  nodes["foot_rear_left"] = node_foot_rear_left_16;
  const mesh_foot_rear_left_16Geometry = endpoint_foot_rear_left_16
    ? new THREE.CylinderGeometry(endpoint_foot_rear_left_16.endRadius, endpoint_foot_rear_left_16.baseRadius, endpoint_foot_rear_left_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_foot_rear_left_16 = new THREE.Mesh(
    mesh_foot_rear_left_16Geometry,
    materialMap["feet_gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_rear_left_16.name = "Rear left foot";
  if (endpoint_foot_rear_left_16) {
    mesh_foot_rear_left_16.position.copy(endpoint_foot_rear_left_16.midpoint);
    mesh_foot_rear_left_16.quaternion.copy(endpoint_foot_rear_left_16.quaternion);
  }
  mesh_foot_rear_left_16.castShadow = options.castShadow ?? true;
  mesh_foot_rear_left_16.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_rear_left_16.userData.sculptComponent = {"actionProfile": {"animationRole": "foot_rear_left", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_rear_left", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 84, 85, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(53, 53, 56, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.9, "height": 1.7, "units": "Blockbench units", "width": 4.6}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "foot_rear_left", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "feet_gray", "materialLayers": ["feet_gray"], "name": "Rear left foot", "parent": null, "primitive": "box", "role": "rear left broad foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [4.1, 0.85, -4.2], "rotation": [0.0, 0.0, 0.0], "scale": [4.6, 1.7, 4.9]}};
  node_foot_rear_left_16.add(mesh_foot_rear_left_16);
  meshes["foot_rear_left"] = mesh_foot_rear_left_16;
  colliders["foot_rear_left"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"};
  destructionGroups["foot_rear_left"] ??= [];
  destructionGroups["foot_rear_left"].push(node_foot_rear_left_16);

  const attachment_leg_rear_right_17 = null;
  const endpoint_leg_rear_right_17 = makeAttachmentEndpoint(attachment_leg_rear_right_17);
  const node_leg_rear_right_17 = new THREE.Group();
  node_leg_rear_right_17.name = "Rear right leg__pivot";
  if (endpoint_leg_rear_right_17) {
    node_leg_rear_right_17.position.copy(endpoint_leg_rear_right_17.start);
    node_leg_rear_right_17.rotation.set(0, 0, 0);
    node_leg_rear_right_17.scale.set(1, 1, 1);
  } else {
    node_leg_rear_right_17.position.set(-4.1, 4.45, -4.6);
    node_leg_rear_right_17.rotation.set(0.0, 0.0, 0.0);
    node_leg_rear_right_17.scale.set(4.1, 8.2, 4.1);
  }
  node_leg_rear_right_17.userData.sculptComponent = {"actionProfile": {"animationRole": "leg_rear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_rear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 8.2, "units": "Blockbench units", "width": 4.1}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "leg_rear_right", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Rear right leg", "parent": null, "primitive": "box", "role": "rear right pillar leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.1, 4.45, -4.6], "rotation": [0.0, 0.0, 0.0], "scale": [4.1, 8.2, 4.1]}};
  node_leg_rear_right_17.userData.actionProfile = {"animationRole": "leg_rear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_rear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_leg_rear_right_17);
  nodes["leg_rear_right"] = node_leg_rear_right_17;
  const mesh_leg_rear_right_17Geometry = endpoint_leg_rear_right_17
    ? new THREE.CylinderGeometry(endpoint_leg_rear_right_17.endRadius, endpoint_leg_rear_right_17.baseRadius, endpoint_leg_rear_right_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_leg_rear_right_17 = new THREE.Mesh(
    mesh_leg_rear_right_17Geometry,
    materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_rear_right_17.name = "Rear right leg";
  if (endpoint_leg_rear_right_17) {
    mesh_leg_rear_right_17.position.copy(endpoint_leg_rear_right_17.midpoint);
    mesh_leg_rear_right_17.quaternion.copy(endpoint_leg_rear_right_17.quaternion);
  }
  mesh_leg_rear_right_17.castShadow = options.castShadow ?? true;
  mesh_leg_rear_right_17.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_rear_right_17.userData.sculptComponent = {"actionProfile": {"animationRole": "leg_rear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "gray_hide", "detachableFragments": [], "fractureGroup": "leg_rear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 101, 101, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(65, 65, 66, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["mottled-hide"], "dimensions": {"confidence": 0.9, "depth": 4.1, "height": 8.2, "units": "Blockbench units", "width": 4.1}, "evidenceRefs": ["full-object"], "fidelityTier": "blockout", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "leg_rear_right", "importance": 1.0, "joints": [], "level": "macro", "localFeatures": ["mottled-hide"], "material": "gray_hide", "materialLayers": ["gray_hide"], "name": "Rear right leg", "parent": null, "primitive": "box", "role": "rear right pillar leg", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.1, 4.45, -4.6], "rotation": [0.0, 0.0, 0.0], "scale": [4.1, 8.2, 4.1]}};
  node_leg_rear_right_17.add(mesh_leg_rear_right_17);
  meshes["leg_rear_right"] = mesh_leg_rear_right_17;
  colliders["leg_rear_right"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.1, 8.2, 4.1], "type": "box"};
  destructionGroups["leg_rear_right"] ??= [];
  destructionGroups["leg_rear_right"].push(node_leg_rear_right_17);

  const attachment_foot_rear_right_18 = null;
  const endpoint_foot_rear_right_18 = makeAttachmentEndpoint(attachment_foot_rear_right_18);
  const node_foot_rear_right_18 = new THREE.Group();
  node_foot_rear_right_18.name = "Rear right foot__pivot";
  if (endpoint_foot_rear_right_18) {
    node_foot_rear_right_18.position.copy(endpoint_foot_rear_right_18.start);
    node_foot_rear_right_18.rotation.set(0, 0, 0);
    node_foot_rear_right_18.scale.set(1, 1, 1);
  } else {
    node_foot_rear_right_18.position.set(-4.1, 0.85, -4.2);
    node_foot_rear_right_18.rotation.set(0.0, 0.0, 0.0);
    node_foot_rear_right_18.scale.set(4.6, 1.7, 4.9);
  }
  node_foot_rear_right_18.userData.sculptComponent = {"actionProfile": {"animationRole": "foot_rear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_rear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 84, 85, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(53, 53, 56, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.9, "height": 1.7, "units": "Blockbench units", "width": 4.6}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "foot_rear_right", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "feet_gray", "materialLayers": ["feet_gray"], "name": "Rear right foot", "parent": null, "primitive": "box", "role": "rear right broad foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.1, 0.85, -4.2], "rotation": [0.0, 0.0, 0.0], "scale": [4.6, 1.7, 4.9]}};
  node_foot_rear_right_18.userData.actionProfile = {"animationRole": "foot_rear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_rear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_foot_rear_right_18);
  nodes["foot_rear_right"] = node_foot_rear_right_18;
  const mesh_foot_rear_right_18Geometry = endpoint_foot_rear_right_18
    ? new THREE.CylinderGeometry(endpoint_foot_rear_right_18.endRadius, endpoint_foot_rear_right_18.baseRadius, endpoint_foot_rear_right_18.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_foot_rear_right_18 = new THREE.Mesh(
    mesh_foot_rear_right_18Geometry,
    materialMap["feet_gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_rear_right_18.name = "Rear right foot";
  if (endpoint_foot_rear_right_18) {
    mesh_foot_rear_right_18.position.copy(endpoint_foot_rear_right_18.midpoint);
    mesh_foot_rear_right_18.quaternion.copy(endpoint_foot_rear_right_18.quaternion);
  }
  mesh_foot_rear_right_18.castShadow = options.castShadow ?? true;
  mesh_foot_rear_right_18.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_rear_right_18.userData.sculptComponent = {"actionProfile": {"animationRole": "foot_rear_right", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "feet_gray", "detachableFragments": [], "fractureGroup": "foot_rear_right", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 84, 85, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(53, 53, 56, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.9, "height": 1.7, "units": "Blockbench units", "width": 4.6}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "foot_rear_right", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "feet_gray", "materialLayers": ["feet_gray"], "name": "Rear right foot", "parent": null, "primitive": "box", "role": "rear right broad foot", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [-4.1, 0.85, -4.2], "rotation": [0.0, 0.0, 0.0], "scale": [4.6, 1.7, 4.9]}};
  node_foot_rear_right_18.add(mesh_foot_rear_right_18);
  meshes["foot_rear_right"] = mesh_foot_rear_right_18;
  colliders["foot_rear_right"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [4.6, 1.7, 4.9], "type": "box"};
  destructionGroups["foot_rear_right"] ??= [];
  destructionGroups["foot_rear_right"].push(node_foot_rear_right_18);

  const attachment_tail_base_19 = null;
  const endpoint_tail_base_19 = makeAttachmentEndpoint(attachment_tail_base_19);
  const node_tail_base_19 = new THREE.Group();
  node_tail_base_19.name = "Tail base__pivot";
  if (endpoint_tail_base_19) {
    node_tail_base_19.position.copy(endpoint_tail_base_19.start);
    node_tail_base_19.rotation.set(0, 0, 0);
    node_tail_base_19.scale.set(1, 1, 1);
  } else {
    node_tail_base_19.position.set(0.0, 8.8, -8.9);
    node_tail_base_19.rotation.set(-0.5061454830783556, 0.0, 0.0);
    node_tail_base_19.scale.set(1.5, 1.5, 4.6);
  }
  node_tail_base_19.userData.sculptComponent = {"actionProfile": {"animationRole": "tail_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.5, 1.5, 4.6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "tail_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(75, 74, 75, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 48, 51, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.6, "height": 1.5, "units": "Blockbench units", "width": 1.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tail_base", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "dark_gray", "materialLayers": ["dark_gray"], "name": "Tail base", "parent": null, "primitive": "box", "role": "short hanging tail", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 8.8, -8.9], "rotation": [-0.5061454830783556, 0.0, 0.0], "scale": [1.5, 1.5, 4.6]}};
  node_tail_base_19.userData.actionProfile = {"animationRole": "tail_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.5, 1.5, 4.6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "tail_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_tail_base_19);
  nodes["tail_base"] = node_tail_base_19;
  const mesh_tail_base_19Geometry = endpoint_tail_base_19
    ? new THREE.CylinderGeometry(endpoint_tail_base_19.endRadius, endpoint_tail_base_19.baseRadius, endpoint_tail_base_19.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tail_base_19 = new THREE.Mesh(
    mesh_tail_base_19Geometry,
    materialMap["dark_gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_base_19.name = "Tail base";
  if (endpoint_tail_base_19) {
    mesh_tail_base_19.position.copy(endpoint_tail_base_19.midpoint);
    mesh_tail_base_19.quaternion.copy(endpoint_tail_base_19.quaternion);
  }
  mesh_tail_base_19.castShadow = options.castShadow ?? true;
  mesh_tail_base_19.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_base_19.userData.sculptComponent = {"actionProfile": {"animationRole": "tail_base", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.5, 1.5, 4.6], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "dark_gray", "detachableFragments": [], "fractureGroup": "tail_base", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(75, 74, 75, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(48, 48, 51, 1.0)"}, "confidence": 0.88, "deformations": [], "details": [], "dimensions": {"confidence": 0.9, "depth": 4.6, "height": 1.5, "units": "Blockbench units", "width": 1.5}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tail_base", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": [], "material": "dark_gray", "materialLayers": ["dark_gray"], "name": "Tail base", "parent": null, "primitive": "box", "role": "short hanging tail", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 8.8, -8.9], "rotation": [-0.5061454830783556, 0.0, 0.0], "scale": [1.5, 1.5, 4.6]}};
  node_tail_base_19.add(mesh_tail_base_19);
  meshes["tail_base"] = mesh_tail_base_19;
  colliders["tail_base"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [1.5, 1.5, 4.6], "type": "box"};
  destructionGroups["tail_base"] ??= [];
  destructionGroups["tail_base"].push(node_tail_base_19);

  const attachment_tail_tuft_20 = null;
  const endpoint_tail_tuft_20 = makeAttachmentEndpoint(attachment_tail_tuft_20);
  const node_tail_tuft_20 = new THREE.Group();
  node_tail_tuft_20.name = "Tail tuft__pivot";
  if (endpoint_tail_tuft_20) {
    node_tail_tuft_20.position.copy(endpoint_tail_tuft_20.start);
    node_tail_tuft_20.rotation.set(0, 0, 0);
    node_tail_tuft_20.scale.set(1, 1, 1);
  } else {
    node_tail_tuft_20.position.set(0.0, 6.7, -10.7);
    node_tail_tuft_20.rotation.set(-0.33161255787892263, 0.0, 0.0);
    node_tail_tuft_20.scale.set(2.3, 2.6, 2.9);
  }
  node_tail_tuft_20.userData.sculptComponent = {"actionProfile": {"animationRole": "tail_tuft", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.3, 2.6, 2.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail_dark", "detachableFragments": [], "fractureGroup": "tail_tuft", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(57, 56, 58, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(34, 34, 37, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["tufted-tail"], "dimensions": {"confidence": 0.9, "depth": 2.9, "height": 2.6, "units": "Blockbench units", "width": 2.3}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tail_tuft", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["tufted-tail"], "material": "tail_dark", "materialLayers": ["tail_dark"], "name": "Tail tuft", "parent": null, "primitive": "box", "role": "dark blocky tail tuft", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 6.7, -10.7], "rotation": [-0.33161255787892263, 0.0, 0.0], "scale": [2.3, 2.6, 2.9]}};
  node_tail_tuft_20.userData.actionProfile = {"animationRole": "tail_tuft", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.3, 2.6, 2.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail_dark", "detachableFragments": [], "fractureGroup": "tail_tuft", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}};
  (nodes["root"] ?? root).add(node_tail_tuft_20);
  nodes["tail_tuft"] = node_tail_tuft_20;
  const mesh_tail_tuft_20Geometry = endpoint_tail_tuft_20
    ? new THREE.CylinderGeometry(endpoint_tail_tuft_20.endRadius, endpoint_tail_tuft_20.baseRadius, endpoint_tail_tuft_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tail_tuft_20 = new THREE.Mesh(
    mesh_tail_tuft_20Geometry,
    materialMap["tail_dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_tuft_20.name = "Tail tuft";
  if (endpoint_tail_tuft_20) {
    mesh_tail_tuft_20.position.copy(endpoint_tail_tuft_20.midpoint);
    mesh_tail_tuft_20.quaternion.copy(endpoint_tail_tuft_20.quaternion);
  }
  mesh_tail_tuft_20.castShadow = options.castShadow ?? true;
  mesh_tail_tuft_20.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_tuft_20.userData.sculptComponent = {"actionProfile": {"animationRole": "tail_tuft", "collider": {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.3, 2.6, 2.9], "type": "box"}, "constraints": [], "destruction": {"breakImpulse": 0.0, "breakable": false, "debrisMaterial": "tail_dark", "detachableFragments": [], "fractureGroup": "tail_tuft", "seamRefs": []}, "pivot": {"axis": [0, 1, 0], "confidence": 0.85, "localPosition": [0, 0, 0], "mode": "component-center"}, "sockets": [], "transformChannels": {"bend": false, "detach": false, "materialState": true, "rotate": true, "scale": true, "translate": true, "twist": false, "visibility": true}}, "attachment": null, "colorMaterialRecipe": {"dominantAlbedo": "rgba(57, 56, 58, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.82, "secondaryAlbedo": "rgba(34, 34, 37, 1.0)"}, "confidence": 0.88, "deformations": [], "details": ["tufted-tail"], "dimensions": {"confidence": 0.9, "depth": 2.9, "height": 2.6, "units": "Blockbench units", "width": 2.3}, "evidenceRefs": ["full-object"], "fidelityTier": "structural-pass", "geometryDescriptor": {"deformationStack": [], "edgeTreatment": {"bevelRadius": 0.0, "segments": 1, "type": "none"}, "normalStrategy": "flat cuboid normals", "topologyIntent": "native Minecraft cuboid with hard square edges", "uvStrategy": "generated procedural coordinates"}, "id": "tail_tuft", "importance": 0.78, "joints": [], "level": "meso", "localFeatures": ["tufted-tail"], "material": "tail_dark", "materialLayers": ["tail_dark"], "name": "Tail tuft", "parent": null, "primitive": "box", "role": "dark blocky tail tuft", "seams": [], "surfaceDetail": {"bumpAmplitude": 0.02, "displacementPattern": "", "edgeWearPattern": "minimal", "macroRoughness": 0.12, "microRoughness": 0.04, "normalPattern": "square-pixel mottling", "notes": "Preserve the Minecraft block silhouette.", "occlusionPattern": "contact darkening"}, "topologyClass": "assembled-solid", "topologyRationale": "The reference is explicitly constructed from crisp rectangular Minecraft volumes.", "transform": {"position": [0, 6.7, -10.7], "rotation": [-0.33161255787892263, 0.0, 0.0], "scale": [2.3, 2.6, 2.9]}};
  node_tail_tuft_20.add(mesh_tail_tuft_20);
  meshes["tail_tuft"] = mesh_tail_tuft_20;
  colliders["tail_tuft"] = {"isTrigger": false, "offset": [0, 0, 0], "scale": [2.3, 2.6, 2.9], "type": "box"};
  destructionGroups["tail_tuft"] ??= [];
  destructionGroups["tail_tuft"].push(node_tail_tuft_20);

  // repetition system: paired-anatomy (InstancedMesh, radial, count=16, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["gray_hide"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 16);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 16; i++) {
      const ang = ((0.0) + (i * 360) / 16) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "paired-anatomy";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"lightingPass": {"mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"], "requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"]}, "materialPass": {"albedoPaletteRequired": true, "geometryReliefRequiredWhenSilhouetteAffected": true, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "localOverridesRequired": true, "minimumTextureResolution": 256, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"], "normalOrBumpRequired": true, "preferredTextureResolution": 256, "referencePbrExtraction": {"acceptedLimitation": "The Minecraft BBModel target preserves albedo only. Reference pixels are baked into cuboid faces by the img2blockbench adapter; Three.js PBR maps remain preview-only.", "requiredWhenSourceImagePresent": false, "stopOnLowConfidence": false, "targetThreshold": 0.7}, "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "roughnessVariationRequired": true}, "qualityPriority": "reference-fidelity", "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createMinecraftElephantLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Minecraft Elephant look-dev lights";
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
export function createMinecraftElephantEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameMinecraftElephantCamera(
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
export function createMinecraftElephantPresentationComposer(
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
