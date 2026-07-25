import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const animals = [
  "platypus",
  "chimpanzee",
  "elephant",
  "tiger",
  "coyote",
];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const modelDirectory = path.join(scriptDirectory, "..", "public", "models");
const voxelResolution = 42;

function elementBoxes(model) {
  return model.elements
    .filter((element) => element.type === "cube")
    .map((element, index) => {
      const from = new THREE.Vector3(...element.from);
      const to = new THREE.Vector3(...element.to);
      const size = to.clone().sub(from);
      size.set(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z));
      const center = from.clone().add(to).multiplyScalar(0.5);
      const origin = new THREE.Vector3(...(element.origin ?? center.toArray()));
      const rotation = element.rotation ?? [0, 0, 0];
      const euler = new THREE.Euler(
        THREE.MathUtils.degToRad(rotation[0]),
        THREE.MathUtils.degToRad(rotation[1]),
        THREE.MathUtils.degToRad(rotation[2]),
        "ZYX",
      );
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      const worldCenter = center
        .clone()
        .sub(origin)
        .applyQuaternion(quaternion)
        .add(origin);
      const corners = [];

      for (const x of [-0.5, 0.5]) {
        for (const y of [-0.5, 0.5]) {
          for (const z of [-0.5, 0.5]) {
            corners.push(
              new THREE.Vector3(x * size.x, y * size.y, z * size.z)
                .applyQuaternion(quaternion)
                .add(worldCenter),
            );
          }
        }
      }

      const bounds = new THREE.Box3().setFromPoints(corners);
      return {
        index,
        name: element.name ?? `cube_${index}`,
        center: worldCenter,
        size,
        quaternion,
        bounds,
      };
    });
}

function normalizeBoxes(boxes) {
  const modelBounds = boxes.reduce(
    (bounds, box) => bounds.union(box.bounds),
    new THREE.Box3(),
  );
  const modelCenter = modelBounds.getCenter(new THREE.Vector3());
  const span = modelBounds.getSize(new THREE.Vector3());
  const scale = 1 / Math.max(span.x, span.y, span.z);

  return boxes.map((box) => {
    const center = box.center.clone().sub(modelCenter).multiplyScalar(scale);
    const size = box.size.clone().multiplyScalar(scale);
    const bounds = new THREE.Box3(
      box.bounds.min.clone().sub(modelCenter).multiplyScalar(scale),
      box.bounds.max.clone().sub(modelCenter).multiplyScalar(scale),
    );
    const inverseRotation = new THREE.Matrix3().setFromMatrix4(
      new THREE.Matrix4()
        .makeRotationFromQuaternion(box.quaternion)
        .invert(),
    );

    return {
      ...box,
      center,
      size,
      halfSize: size.clone().multiplyScalar(0.5),
      bounds,
      inverseRotation,
    };
  });
}

function voxelize(boxes) {
  const count = voxelResolution ** 3;
  const occupied = new Uint8Array(count);
  const step = 1.08 / voxelResolution;
  let offset = 0;

  for (let zIndex = 0; zIndex < voxelResolution; zIndex += 1) {
    const z = -0.54 + (zIndex + 0.5) * step;
    for (let yIndex = 0; yIndex < voxelResolution; yIndex += 1) {
      const y = -0.54 + (yIndex + 0.5) * step;
      for (let xIndex = 0; xIndex < voxelResolution; xIndex += 1) {
        const x = -0.54 + (xIndex + 0.5) * step;

        for (const box of boxes) {
          const dx = x - box.center.x;
          const dy = y - box.center.y;
          const dz = z - box.center.z;
          const matrix = box.inverseRotation.elements;
          const localX = matrix[0] * dx + matrix[3] * dy + matrix[6] * dz;
          const localY = matrix[1] * dx + matrix[4] * dy + matrix[7] * dz;
          const localZ = matrix[2] * dx + matrix[5] * dy + matrix[8] * dz;

          if (
            Math.abs(localX) <= box.halfSize.x &&
            Math.abs(localY) <= box.halfSize.y &&
            Math.abs(localZ) <= box.halfSize.z
          ) {
            occupied[offset] = 1;
            break;
          }
        }
        offset += 1;
      }
    }
  }

  return occupied;
}

function shapeIou(left, right) {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] || right[index]) union += 1;
    if (left[index] && right[index]) intersection += 1;
  }
  return union ? intersection / union : 1;
}

function dimensionSimilarity(left, right) {
  const ratios = ["x", "y", "z"].map((axis) => {
    const minimum = Math.min(left.size[axis], right.size[axis]);
    const maximum = Math.max(left.size[axis], right.size[axis]);
    return maximum ? minimum / maximum : 1;
  });
  return ratios.reduce((total, value) => total + value, 0) / ratios.length;
}

function rotationSimilarity(left, right) {
  const dot = Math.min(1, Math.abs(left.quaternion.dot(right.quaternion)));
  const difference = 2 * Math.acos(dot);
  return 1 - difference / Math.PI;
}

function pairSimilarity(left, right) {
  const centerDistance = left.center.distanceTo(right.center);
  const center = Math.exp(-4 * centerDistance);
  const dimensions = dimensionSimilarity(left, right);
  const rotation = rotationSimilarity(left, right);
  return center * 0.5 + dimensions * 0.35 + rotation * 0.15;
}

function hungarian(costs) {
  const rowCount = costs.length;
  const columnCount = costs[0].length;
  const rowPotential = new Array(rowCount + 1).fill(0);
  const columnPotential = new Array(columnCount + 1).fill(0);
  const matching = new Array(columnCount + 1).fill(0);
  const path = new Array(columnCount + 1).fill(0);

  for (let row = 1; row <= rowCount; row += 1) {
    matching[0] = row;
    let column = 0;
    const minimum = new Array(columnCount + 1).fill(Infinity);
    const used = new Array(columnCount + 1).fill(false);

    do {
      used[column] = true;
      const matchedRow = matching[column];
      let delta = Infinity;
      let nextColumn = 0;

      for (
        let candidate = 1;
        candidate <= columnCount;
        candidate += 1
      ) {
        if (used[candidate]) continue;
        const current =
          costs[matchedRow - 1][candidate - 1] -
          rowPotential[matchedRow] -
          columnPotential[candidate];
        if (current < minimum[candidate]) {
          minimum[candidate] = current;
          path[candidate] = column;
        }
        if (minimum[candidate] < delta) {
          delta = minimum[candidate];
          nextColumn = candidate;
        }
      }

      for (
        let candidate = 0;
        candidate <= columnCount;
        candidate += 1
      ) {
        if (used[candidate]) {
          rowPotential[matching[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else {
          minimum[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (matching[column] !== 0);

    do {
      const previous = path[column];
      matching[column] = matching[previous];
      column = previous;
    } while (column !== 0);
  }

  const assignment = new Array(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column += 1) {
    if (matching[column]) assignment[matching[column] - 1] = column - 1;
  }
  return assignment;
}

function boxesTouch(left, right) {
  const gaps = ["x", "y", "z"].map((axis) =>
    Math.max(
      0,
      left.bounds.min[axis] - right.bounds.max[axis],
      right.bounds.min[axis] - left.bounds.max[axis],
    ),
  );
  const overlaps = gaps.filter((gap) => gap === 0).length;
  const distance = Math.hypot(...gaps);
  return overlaps >= 2 && distance <= 0.025;
}

function topologySimilarity(leftBoxes, rightBoxes, assignment) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (let left = 0; left < assignment.length; left += 1) {
    for (let right = left + 1; right < assignment.length; right += 1) {
      const leftEdge = boxesTouch(leftBoxes[left], leftBoxes[right]);
      const rightEdge = boxesTouch(
        rightBoxes[assignment[left]],
        rightBoxes[assignment[right]],
      );
      if (leftEdge && rightEdge) truePositive += 1;
      if (!leftEdge && rightEdge) falsePositive += 1;
      if (leftEdge && !rightEdge) falseNegative += 1;
    }
  }

  const denominator = 2 * truePositive + falsePositive + falseNegative;
  return denominator ? (2 * truePositive) / denominator : 1;
}

function percent(value) {
  return Math.round(value * 1000) / 10;
}

async function compareAnimal(animal) {
  const [lane1Model, lane3Model] = await Promise.all(
    ["lane1", "lane3"].map(async (lane) =>
      JSON.parse(
        await readFile(
          path.join(modelDirectory, `${animal}-${lane}.bbmodel`),
          "utf8",
        ),
      ),
    ),
  );
  const lane1 = normalizeBoxes(elementBoxes(lane1Model));
  const lane3 = normalizeBoxes(elementBoxes(lane3Model));
  const costs = lane1.map((left) =>
    lane3.map((right) => 1 - pairSimilarity(left, right)),
  );
  const assignment = hungarian(costs);
  const dimensions =
    assignment.reduce(
      (total, lane3Index, lane1Index) =>
        total + dimensionSimilarity(lane1[lane1Index], lane3[lane3Index]),
      0,
    ) / assignment.length;
  const rotations =
    assignment.reduce(
      (total, lane3Index, lane1Index) =>
        total + rotationSimilarity(lane1[lane1Index], lane3[lane3Index]),
      0,
    ) / assignment.length;
  const shape = shapeIou(voxelize(lane1), voxelize(lane3));
  const topology = topologySimilarity(lane1, lane3, assignment);
  const boxCount = Math.min(lane1.length, lane3.length) /
    Math.max(lane1.length, lane3.length);
  const overall =
    shape * 0.35 +
    topology * 0.2 +
    boxCount * 0.15 +
    dimensions * 0.2 +
    rotations * 0.1;

  return {
    animal,
    lane1Boxes: lane1.length,
    lane3Boxes: lane3.length,
    shape: percent(shape),
    topology: percent(topology),
    boxCount: percent(boxCount),
    dimensions: percent(dimensions),
    rotations: percent(rotations),
    overall: percent(overall),
  };
}

const results = await Promise.all(animals.map(compareAnimal));
console.log("Current Lane 1 vs Lane 3 blockout structural baseline\n");
console.table(results);
console.log(
  "\nMethod: uniformly normalized geometry; 42³ occupancy IoU; optimal cuboid matching; matched adjacency F1. Textures excluded.",
);
