import { createMinecraftPlatypusModel } from "../../examples/platypus/lane3/createMinecraftPlatypusModel.generated";
import { createMinecraftChimpanzeeModel } from "../../examples/chimpanzee/lane3/createMinecraftChimpanzeeModel.generated";
import { createMinecraftElephantModel } from "../../examples/elephant/lane3/createMinecraftElephantModel.generated";
import { createMinecraftTigerModel } from "../../examples/tiger/lane3/createMinecraftTigerModel.generated";
import { createMinecraftCoyoteModel } from "../../examples/coyote/lane3/createMinecraftCoyoteModel.generated";

const factories = {
  platypus: createMinecraftPlatypusModel,
  chimpanzee: createMinecraftChimpanzeeModel,
  elephant: createMinecraftElephantModel,
  tiger: createMinecraftTigerModel,
  coyote: createMinecraftCoyoteModel,
} as const;

const requestedAnimal = new URLSearchParams(window.location.search).get("animal") ?? "platypus";
if (!(requestedAnimal in factories)) {
  throw new Error(`Unknown animal: ${requestedAnimal}`);
}

const root = factories[requestedAnimal as keyof typeof factories]({
  castShadow: true,
  receiveShadow: true,
  textureSize: 64,
  textureAnisotropy: 1,
  qualityPriority: "balanced",
});

delete root.userData.sculptRuntime;
root.userData.img2threejs = {
  repository: "https://github.com/hoainho/img2threejs",
  commit: "c9077d5ecce834f6802d6742b4a5b2c682d6279d",
  generator: "forge/stage3_build/generate_threejs_factory.py",
  generatedPass: "blockout",
};
root.userData.img2blockbench = {
  source: "official-img2threejs",
  compatibility: "box-only",
  animal: requestedAnimal,
};
root.updateMatrixWorld(true);

document.body.dataset.exportStatus = "ready";
document.body.textContent = JSON.stringify(root.toJSON());
