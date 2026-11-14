# A four-legged rig and walk (draft)

A draft skeleton template and walk gait for a plantigrade four-legged character, drafted from a small mammal's anatomy. It was tuned on one generated model until the generated walk passed every QA check. Treat every number as a starting point for your own character.

The walk is plantigrade: the whole hind foot goes down, the front paws land flat like hands and curl down at the wrist in the swing. The back is hunched with the rump higher than the shoulders, the head is low, and the tail hangs low and sways with the hips. The steps are short and quick, and the feet stay planted in stance.

## Files

- `quadruped-template.json`: the skeleton template (joints, limits, four plantigrade feet).
- `walk.json`: the walk gait profile.
- `profile-fragment.json`: the `model3d` additions a target profile needs. It names the template by a path relative to the profile.

## Conventions

- Rest positions are fractions of body length, where body length is the whole front-to-back extent including the tail. The frame is +z forward, +y up, +x the animal's left. The origin is at the ground, on the body's midline, at the bounds' centre on z. The nose is near z = +0.5 and the tail tip near z = -0.5. The left and right legs mirror each other.
- Limits are degrees of local rotation from rest, as X-Y-Z Euler angles. A positive x rotation is a right-hand rotation about +x (the animal's left axis), which pitches a forward-pointing bone down. So positive x on a wrist curls the paw down (flexion), and negative x extends it. Positive x on the neck lowers the head.
- Weight-bearing wrists and ankles have `stanceLimits`. A wrist may flex at most 30° in stance, so it never folds. It may extend to -55°, because the paw stays flat while the forearm passes over it. Ankles are held to [-40, 35]°. Both are held to ±15° of yaw and roll in stance. The full `limits` let the wrist flex to 80° in the swing.
- On the model it was tuned on, the worst stance wrist extension is about -49°. About 14° of that comes from laying that model's slightly down-tilted paw flat. The knee and elbow allow ±20° of yaw and roll, because a fitted leg's hinge axis is not exactly the animal's left axis.
- In the gait, positive `backArchDeg` hunches the back, positive `headPitchDeg` lowers the head, positive `tailPitchDeg` lowers the tail, and `hipHeightRatio` above 1 raises the rump. The footfall is the lateral-sequence walk.
- The template has `ear_l` and `ear_r`, parented to the head, so the ears ride rigidly on the head when it pitches down.

## Applying it to a model

Merge the `model3d` fragment from `profile-fragment.json` into your target profile. Place `quadruped-template.json` so the template path resolves relative to that profile. Add `"reference": "<dir of frames>"` to the walk gait (relative to the profile) for a side-by-side with reference frames. Then run:

    assetgrove rig --model model.glb --provenance provenance.json --spec character-3d.json --profile profile.json

## Limits found while tuning

A deeper hunch (`backArchDeg` 24 to 26, `headPitchDeg` 30 to 32) pushes the stance wrist's yaw just past ±15° and fails joint-limit QA.
