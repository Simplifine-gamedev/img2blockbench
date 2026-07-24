# Quality rubric

## Contents

1. [Reference](#reference)
2. [Geometry](#geometry)
3. [Texture](#texture)
4. [Rigging](#rigging)
5. [Required renders](#required-renders)
6. [Approval](#approval)

## Reference

- The subject already uses Minecraft-native cuboid forms and square-pixel
  materials.
- Show the full subject without severe occlusion.
- Prefer a neutral pose and weak perspective.
- Record ambiguous depth, hidden limbs, and unseen markings.
- Request another image when ambiguity controls the subject's identity.
- Reject photographs and smooth organic illustrations from Lane 1 until they
  are restyled as Minecraft concepts.

## Geometry

- Every cuboid has a semantic purpose.
- Medium mobs normally use 15–35 cuboids.
- Paired anatomy is symmetric unless intentionally different.
- Jointed segments share pivots and overlap slightly.
- No floating hands, feet, jaws, wings, or tail segments.
- No geometry is split merely because texture color changes.
- The silhouette reads correctly from front, side, and isometric views.

## Texture

- One texel density is used across all faces.
- Pixel patterns are nearest-neighbor; palette reduction introduces no noise.
- Eyes, nostrils, mouth lines, markings, and seams are texture pixels.
- Both face sides point toward the same anatomical front.
- Atlas gutters do not bleed unrelated colors.
- Identity features survive palette reduction.

## Rigging

- Exactly one root bone exists.
- Every cube belongs to an existing bone.
- Pivots sit at anatomical joints.
- Parent chains follow the creature's actual articulation.
- Collision width, height, and eye height are plausible gameplay values.

## Required renders

Inspect:

- left and right full body;
- front and back;
- isometric;
- left and right head close-ups;
- close-ups of connected joints;
- animation playback when animations exist.

Structural audits cannot approve anatomical direction, resemblance, expression,
or animation quality.

## Approval

Approve only when:

- the subject is immediately recognizable;
- both sides of the face agree;
- no joint visibly detaches;
- the model looks Minecraft-native rather than voxelized;
- all required views were inspected;
- the generated audit reports no errors.
