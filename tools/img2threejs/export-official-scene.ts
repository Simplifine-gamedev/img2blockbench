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
  textureSize: 256,
  textureAnisotropy: 4,
  qualityPriority: "reference-fidelity",
});

delete root.userData.sculptRuntime;
root.userData.img2threejs = {
  repository: "https://github.com/img2threejs/img2threejs",
  commit: "f1ade81d45252ede20323d74a5b269c819f75245",
  generator: "forge/stage3_build/generate_threejs_factory.py",
  generatedPass: "optimization-pass",
};
root.userData.img2blockbench = {
  source: "official-img2threejs",
  compatibility: "box-only",
  animal: requestedAnimal,
  frontAxis: "positive_z",
};
root.updateMatrixWorld(true);

document.body.dataset.exportStatus = "ready";
document.body.textContent = JSON.stringify(root.toJSON());
