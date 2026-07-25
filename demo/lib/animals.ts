export const animalOrder = [
  "platypus",
  "chimpanzee",
  "elephant",
  "tiger",
  "coyote",
] as const;

export type AnimalSlug = (typeof animalOrder)[number];

export const laneOrder = ["lane1", "lane2", "lane3"] as const;
export type LaneSlug = (typeof laneOrder)[number];

export type ModelStats = {
  modelFile: string;
  cuboids: number;
  groups: number;
  texture: string;
  threeSceneFile?: string;
  sceneNodes?: number;
  sceneMaterials?: number;
  sceneSize?: string;
  sourceMaps?: number;
};

export type Animal = {
  slug: AnimalSlug;
  name: string;
  prompt: string;
  accent: string;
  accentSoft: string;
  models: Partial<Record<LaneSlug, ModelStats>>;
};

export type Lane = {
  slug: LaneSlug;
  number: number;
  name: string;
  eyebrow: string;
  pipeline: string;
  gpu: string;
  intermediate: string;
  stages: Array<{ label: string; value: string }>;
};

export const lanes: Record<LaneSlug, Lane> = {
  lane1: {
    slug: "lane1",
    number: 1,
    name: "Direct",
    eyebrow: "DIRECT REASONING OUTPUT",
    pipeline: "IMAGE → CUBOID SPEC → BBMODEL",
    gpu: "None",
    intermediate: "Cuboid spec",
    stages: [
      { label: "Image evidence", value: "REFERENCE" },
      { label: "Native cuboid reasoning", value: "LLM" },
      { label: "Blockbench compiler", value: "NO GPU" },
    ],
  },
  lane2: {
    slug: "lane2",
    number: 2,
    name: "Trellis",
    eyebrow: "MESH-ASSISTED OUTPUT",
    pipeline: "IMAGE → TRELLIS → CUBOIDS",
    gpu: "Required",
    intermediate: "Textured GLB",
    stages: [
      { label: "Image evidence", value: "REFERENCE" },
      { label: "Textured 3D guide", value: "TRELLIS" },
      { label: "Cuboid reconstruction", value: "LLM" },
    ],
  },
  lane3: {
    slug: "lane3",
    number: 3,
    name: "Three.js beta",
    eyebrow: "IMG2THREEJS BLOCKOUT OUTPUT",
    pipeline: "IMAGE → IMG2THREEJS BLOCKOUT → BBMODEL",
    gpu: "None",
    intermediate: "Unreviewed blockout scene",
    stages: [
      { label: "Image evidence", value: "REFERENCE" },
      { label: "Official procedural factory", value: "IMG2THREEJS" },
      { label: "Texture + BBModel adapter", value: "NO GPU" },
    ],
  },
};

export const animals: Record<AnimalSlug, Animal> = {
  platypus: {
    slug: "platypus",
    name: "Platypus",
    prompt:
      "A Minecraft-style platypus with a broad blue-gray bill, webbed feet, a low brown body, and a flat paddle tail.",
    accent: "#52d0ff",
    accentSoft: "#173c4b",
    models: {
      lane1: {
        modelFile: "platypus-lane1.bbmodel",
        cuboids: 16,
        groups: 14,
        texture: "256²",
      },
      lane2: {
        modelFile: "platypus-lane2.bbmodel",
        cuboids: 22,
        groups: 9,
        texture: "256²",
      },
      lane3: {
        modelFile: "platypus-lane3.bbmodel",
        cuboids: 34,
        groups: 35,
        texture: "256²",
        threeSceneFile: "platypus-lane3.three.json",
        sceneNodes: 34,
        sceneMaterials: 8,
        sceneSize: "1.3 MB",
        sourceMaps: 8,
      },
    },
  },
  chimpanzee: {
    slug: "chimpanzee",
    name: "Chimpanzee",
    prompt:
      "A Minecraft-style chimpanzee with long arms, grounded knuckles, a compact black body, and a warm tan face.",
    accent: "#ffb56b",
    accentSoft: "#4b321d",
    models: {
      lane1: {
        modelFile: "chimpanzee-lane1.bbmodel",
        cuboids: 22,
        groups: 20,
        texture: "256²",
      },
      lane2: {
        modelFile: "chimpanzee-lane2.bbmodel",
        cuboids: 24,
        groups: 13,
        texture: "256²",
      },
      lane3: {
        modelFile: "chimpanzee-lane3.bbmodel",
        cuboids: 25,
        groups: 26,
        texture: "256²",
        threeSceneFile: "chimpanzee-lane3.three.json",
        sceneNodes: 25,
        sceneMaterials: 6,
        sceneSize: "1.0 MB",
        sourceMaps: 6,
      },
    },
  },
  elephant: {
    slug: "elephant",
    name: "Elephant",
    prompt:
      "A Minecraft-style elephant with a heavy gray body, wide ears, ivory tusks, sturdy legs, and a curved trunk.",
    accent: "#aebdca",
    accentSoft: "#303b45",
    models: {
      lane1: {
        modelFile: "elephant-lane1.bbmodel",
        cuboids: 21,
        groups: 16,
        texture: "256²",
      },
      lane2: {
        modelFile: "elephant-lane2.bbmodel",
        cuboids: 24,
        groups: 18,
        texture: "256²",
      },
      lane3: {
        modelFile: "elephant-lane3.bbmodel",
        cuboids: 25,
        groups: 26,
        texture: "256²",
        threeSceneFile: "elephant-lane3.three.json",
        sceneNodes: 25,
        sceneMaterials: 7,
        sceneSize: "1.1 MB",
        sourceMaps: 7,
      },
    },
  },
  tiger: {
    slug: "tiger",
    name: "Tiger",
    prompt:
      "A Minecraft-style tiger with a powerful orange body, bold black stripes, white muzzle, four legs, and a long tail.",
    accent: "#ff781f",
    accentSoft: "#4c2511",
    models: {
      lane1: {
        modelFile: "tiger-lane1.bbmodel",
        cuboids: 20,
        groups: 17,
        texture: "256²",
      },
      lane2: {
        modelFile: "tiger-lane2.bbmodel",
        cuboids: 23,
        groups: 13,
        texture: "256²",
      },
      lane3: {
        modelFile: "tiger-lane3.bbmodel",
        cuboids: 26,
        groups: 27,
        texture: "256²",
        threeSceneFile: "tiger-lane3.three.json",
        sceneNodes: 26,
        sceneMaterials: 7,
        sceneSize: "1.2 MB",
        sourceMaps: 7,
      },
    },
  },
  coyote: {
    slug: "coyote",
    name: "Coyote",
    prompt:
      "A Minecraft-style coyote with a lean gray-brown body, oversized upright ears, narrow muzzle, long legs, and a low tail.",
    accent: "#d5b88b",
    accentSoft: "#443926",
    models: {
      lane1: {
        modelFile: "coyote-lane1.bbmodel",
        cuboids: 20,
        groups: 16,
        texture: "256²",
      },
      lane2: {
        modelFile: "coyote-lane2.bbmodel",
        cuboids: 23,
        groups: 13,
        texture: "256²",
      },
      lane3: {
        modelFile: "coyote-lane3.bbmodel",
        cuboids: 24,
        groups: 25,
        texture: "256²",
        threeSceneFile: "coyote-lane3.three.json",
        sceneNodes: 24,
        sceneMaterials: 8,
        sceneSize: "1.2 MB",
        sourceMaps: 8,
      },
    },
  },
};

export function isAnimalSlug(value: string): value is AnimalSlug {
  return animalOrder.includes(value as AnimalSlug);
}

export function isLaneSlug(value: string): value is LaneSlug {
  return laneOrder.includes(value as LaneSlug);
}
