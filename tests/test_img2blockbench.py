import base64
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

import img2blockbench


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "fox" / "model-spec.json"


class Img2BlockbenchTests(unittest.TestCase):
    def test_public_json_reports_do_not_embed_local_home_paths(self):
        for path in (ROOT / "examples").rglob("*.json"):
            contents = path.read_text(encoding="utf-8")
            self.assertNotIn("/Users/", contents, str(path))
            self.assertNotIn("/home/", contents, str(path))
            self.assertNotIn(":\\Users\\", contents, str(path))

    def test_example_is_strictly_valid(self):
        spec = img2blockbench.read_json(EXAMPLE)
        self.assertEqual([], img2blockbench.validate_spec(spec, strict=True))

    def test_probe_and_new_create_valid_starter(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            image_path = folder / "reference.png"
            Image.new("RGB", (64, 32), "#b95832").save(image_path)
            probe = img2blockbench.image_probe(image_path)
            self.assertEqual((probe["width"], probe["height"]), (64, 32))
            output = folder / "model-spec.json"
            starter = img2blockbench.starter_spec(
                image_path,
                output,
                "test_fox",
                "A test fox",
                "moderate",
            )
            self.assertEqual([], img2blockbench.validate_spec(starter))
            self.assertTrue(img2blockbench.validate_spec(starter, strict=True))

    def test_build_is_audited_and_deterministic(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            first = folder / "first"
            second = folder / "second"
            result = img2blockbench.build_model(EXAMPLE, first)
            img2blockbench.build_model(EXAMPLE, second)
            self.assertTrue(result["audit"]["ok"])
            self.assertEqual(
                (first / "fox.zip").read_bytes(),
                (second / "fox.zip").read_bytes(),
            )
            bbmodel = img2blockbench.read_json(first / "fox.bbmodel")
            self.assertTrue(img2blockbench.audit_bbmodel(bbmodel)["ok"])
            self.assertTrue((first / "fox.geo.json").exists())
            self.assertTrue((first / "fox.png").exists())
            manifest = img2blockbench.read_json(first / "fox.manifest.json")
            self.assertEqual("direct", manifest["generator"]["lane"])

    def test_missing_bone_is_rejected(self):
        spec = copy.deepcopy(img2blockbench.read_json(EXAMPLE))
        spec["cubes"][0]["bone"] = "missing"
        errors = img2blockbench.validate_spec(spec, strict=True)
        self.assertTrue(any("missing bone" in error for error in errors))

    def test_threejs_factory_uses_same_cuboids(self):
        spec = img2blockbench.read_json(EXAMPLE)
        factory = img2blockbench.make_threejs_factory(spec)
        self.assertIn("export function createFoxModel(): THREE.Group", factory)
        self.assertEqual(len(spec["cubes"]), factory.count("new THREE.BoxGeometry("))
        self.assertIn('representation: "minecraft-cuboids"', factory)

    def test_imports_constrained_threejs_scene(self):
        identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            reference = folder / "reference.png"
            Image.new("RGB", (64, 32), "#70451f").save(reference)
            scene = {
                "metadata": {
                    "version": 4.7,
                    "type": "Object",
                    "generator": "Object3D.toJSON",
                },
                "geometries": [
                    {
                        "uuid": "geometry",
                        "type": "BoxGeometry",
                        "width": 8,
                        "height": 5,
                        "depth": 12,
                    }
                ],
                "materials": [
                    {
                        "uuid": "material",
                        "type": "MeshBasicMaterial",
                        "name": "brown_fur",
                        "color": 0x70451F,
                    }
                ],
                "object": {
                    "uuid": "root",
                    "type": "Group",
                    "name": "test",
                    "matrix": identity,
                    "children": [
                        {
                            "uuid": "pivot",
                            "type": "Group",
                            "name": "body_pivot",
                            "matrix": identity[:12] + [0, 7, 0, 1],
                            "userData": {
                                "img2blockbench": {
                                    "bone": "body",
                                    "parent": "root",
                                    "role": "main body",
                                }
                            },
                            "children": [
                                {
                                    "uuid": "mesh",
                                    "type": "Mesh",
                                    "name": "body",
                                    "matrix": identity,
                                    "geometry": "geometry",
                                    "material": ["material"] * 6,
                                }
                            ],
                        }
                    ],
                },
            }
            scene_path = folder / "scene.json"
            scene_path.write_text(json.dumps(scene))
            output = folder / "model-spec.json"
            spec = img2blockbench.import_threejs_scene(
                scene_path,
                reference,
                output,
                "threejs_test",
                "A procedural test model",
            )
            self.assertEqual(1, len(spec["cubes"]))
            self.assertEqual("brown_fur", spec["cubes"][0]["material"])
            self.assertEqual([], img2blockbench.validate_spec(spec, strict=True))

    def test_imports_img2threejs_scaled_pivots_and_physical_materials(self):
        identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            reference = folder / "reference.png"
            Image.new("RGB", (64, 32), "#6f4525").save(reference)
            scene = {
                "geometries": [
                    {
                        "uuid": "geometry",
                        "type": "BoxGeometry",
                        "width": 1,
                        "height": 1,
                        "depth": 1,
                    }
                ],
                "materials": [
                    {
                        "uuid": "material",
                        "type": "MeshPhysicalMaterial",
                        "color": 0xFFFFFF,
                        "userData": {
                            "sculptMaterial": {
                                "id": "fur",
                                "baseColor": "#6f4525",
                                "colorVariation": {
                                    "palette": [
                                        "#6f4525",
                                        "#4c2d1c",
                                        "#946039",
                                    ]
                                },
                            }
                        },
                    }
                ],
                "object": {
                    "uuid": "root",
                    "type": "Group",
                    "matrix": identity,
                    "children": [
                        {
                            "uuid": "pivot",
                            "type": "Group",
                            "name": "body_pivot",
                            "matrix": [8, 0, 0, 0, 0, 5, 0, 0, 0, 0, 12, 0, 0, 7, 0, 1],
                            "children": [
                                {
                                    "uuid": "mesh",
                                    "type": "Mesh",
                                    "name": "body",
                                    "matrix": identity,
                                    "geometry": "geometry",
                                    "material": "material",
                                }
                            ],
                        }
                    ],
                },
            }
            scene_path = folder / "scene.json"
            scene_path.write_text(json.dumps(scene))
            spec = img2blockbench.import_threejs_scene(
                scene_path,
                reference,
                folder / "model-spec.json",
                "img2threejs_test",
                "An official img2threejs-style scene",
            )
            self.assertEqual([8, 5, 12], spec["cubes"][0]["size"])
            self.assertEqual([0, 7, 0], spec["cubes"][0]["center"])
            material = spec["materials"][spec["cubes"][0]["material"]]
            self.assertEqual("#6f4525", material["base"])
            self.assertEqual("fur", material["source_material_id"])
            self.assertEqual(
                ["#6f4525", "#4c2d1c", "#946039"],
                material["reference_palette"],
            )
            self.assertEqual("threejs", spec["generation"]["lane"])

    def test_imports_and_bakes_img2threejs_albedo_map(self):
        identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        source_image = Image.new("RGBA", (2, 2))
        source_image.putdata(
            [
                (255, 0, 0, 255),
                (0, 255, 0, 255),
                (0, 0, 255, 255),
                (255, 255, 0, 255),
            ]
        )
        buffer = io.BytesIO()
        source_image.save(buffer, format="PNG")
        data_uri = "data:image/png;base64," + base64.b64encode(
            buffer.getvalue()
        ).decode("ascii")

        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            reference = folder / "reference.png"
            Image.new("RGB", (64, 32), "#6f4525").save(reference)
            scene = {
                "geometries": [
                    {
                        "uuid": "geometry",
                        "type": "BoxGeometry",
                        "width": 4,
                        "height": 4,
                        "depth": 4,
                    }
                ],
                "materials": [
                    {
                        "uuid": "material",
                        "type": "MeshPhysicalMaterial",
                        "color": 0xFFFFFF,
                        "map": "texture",
                    }
                ],
                "textures": [
                    {
                        "uuid": "texture",
                        "image": "image",
                        "repeat": [1, 1],
                        "offset": [0, 0],
                        "center": [0, 0],
                        "rotation": 0,
                        "wrap": [1001, 1001],
                        "flipY": True,
                    }
                ],
                "images": [{"uuid": "image", "url": data_uri}],
                "object": {
                    "uuid": "root",
                    "type": "Group",
                    "matrix": identity,
                    "children": [
                        {
                            "uuid": "pivot",
                            "type": "Group",
                            "name": "body_pivot",
                            "matrix": identity,
                            "children": [
                                {
                                    "uuid": "mesh",
                                    "type": "Mesh",
                                    "name": "body",
                                    "matrix": identity,
                                    "geometry": "geometry",
                                    "material": "material",
                                }
                            ],
                        }
                    ],
                },
            }
            scene_path = folder / "scene.json"
            scene_path.write_text(json.dumps(scene))
            spec = img2blockbench.import_threejs_scene(
                scene_path,
                reference,
                folder / "model-spec.json",
                "textured_threejs_test",
                "A textured official img2threejs-style scene",
            )
            material = spec["materials"][spec["cubes"][0]["material"]]
            self.assertEqual(data_uri, material["source_texture"]["data_uri"])
            atlas, _ = img2blockbench.build_texture(spec)
            colors = {
                color
                for _, color in (
                    atlas.getcolors(maxcolors=atlas.width * atlas.height) or []
                )
            }
            self.assertTrue(
                {
                    (255, 0, 0, 255),
                    (0, 255, 0, 255),
                    (0, 0, 255, 255),
                    (255, 255, 0, 255),
                }.issubset(colors)
            )

    def test_face_texture_overrides_procedural_material_and_quantizes(self):
        patch = Image.new("RGBA", (2, 2))
        patch.putdata(
            [
                (255, 0, 0, 255),
                (0, 255, 0, 255),
                (0, 0, 255, 255),
                (255, 255, 0, 255),
            ]
        )
        buffer = io.BytesIO()
        patch.save(buffer, format="PNG")
        data_uri = "data:image/png;base64," + base64.b64encode(
            buffer.getvalue()
        ).decode("ascii")

        spec = copy.deepcopy(img2blockbench.read_json(EXAMPLE))
        spec["texture"]["palette_size"] = 4
        spec["texture"]["quantize_source"] = True
        spec["landmarks"] = []
        spec["cubes"][0]["faces"]["north"] = {
            "source_texture": {
                "data_uri": data_uri,
                "repeat": [1, 1],
                "offset": [0, 0],
                "center": [0, 0],
                "rotation": 0,
                "wrap": [1001, 1001],
                "flip_y": False,
            }
        }

        self.assertEqual([], img2blockbench.validate_spec(spec, strict=True))
        atlas, placements = img2blockbench.build_texture(spec)
        left, top, width, height = placements[
            (spec["cubes"][0]["name"], "north")
        ]
        colors = set(
            atlas.crop(
                (left, top, left + width, top + height)
            ).get_flattened_data()
        )
        self.assertGreaterEqual(len(colors), 2)
        self.assertLessEqual(len(set(atlas.get_flattened_data())), 5)

    def test_strict_validation_checks_reference_provenance(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            reference = folder / "reference.jpg"
            reference.write_bytes((ROOT / "examples" / "fox" / "reference.jpg").read_bytes())
            spec = copy.deepcopy(img2blockbench.read_json(EXAMPLE))
            spec["reference"]["sha256"] = "0" * 64
            spec_path = folder / "model-spec.json"
            img2blockbench.write_json(spec_path, spec)
            with self.assertRaises(img2blockbench.ModelSpecError):
                img2blockbench.validated_spec(spec_path, strict=True)

    def test_audit_rejects_orphan(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            img2blockbench.build_model(EXAMPLE, output)
            model = json.loads((output / "fox.bbmodel").read_text())
            model["outliner"] = []
            self.assertFalse(img2blockbench.audit_bbmodel(model)["ok"])


if __name__ == "__main__":
    unittest.main()
