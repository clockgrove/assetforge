# Raccoon rig and walk (draft)

A draft skeleton template and walk gait for raccoon characters, for clockgrove/raccoon-world#39 to adopt or replace. It was drafted from raccoon anatomy and the issue's description of porch footage of raccoon kits. It is not yet tuned against the frames in `references/stevie/gait-reference/`, which were not reachable when this was written. Treat every number as a first guess.

The walk is plantigrade: the whole hind foot goes down, the front paws land flat like hands and curl down at the wrist in the swing. The back is hunched with the rump higher than the shoulders, the head is low, and the tail hangs low and sways with the hips. The feet stay planted in stance.

## Files

- `raccoon-template.json`: the skeleton template (joints, limits, four plantigrade feet).
- `raccoon-walk.json`: the walk gait profile.
- `profile-fragment.json`: the `model3d` additions a target profile needs. It names the template by a path relative to the profile.

## Conventions

- Rest positions are fractions of body length, where body length is the whole front-to-back extent including the tail. The frame is +z forward, +y up, +x the animal's left, with the origin at the bounds centre on x and z and y = 0 at the ground. The nose is near z = +0.5 and the tail tip near z = -0.5.
- Limits are degrees of local rotation from rest, as X-Y-Z Euler angles. A positive x rotation is a right-hand rotation about +x (the animal's left axis), which pitches a forward-pointing bone down. So positive x on a wrist curls the paw down, and positive x on the neck lowers the head.
- `stanceLimits` on the ankles and wrists are tight (x about -30 to 35, y and z within 10 degrees) so a weight-bearing foot never folds. The full `limits` let the wrist flex up to 80 degrees in the swing.
- In the gait, positive `backArchDeg` hunches the back, positive `headPitchDeg` lowers the head, positive `tailPitchDeg` lowers the tail, and `hipHeightRatio` above 1 raises the rump. The footfall is the lateral-sequence walk.

## Applying it to c3

Make a copy of Raccoon World's profile, merge in the `model3d` fragment from `profile-fragment.json`, and place `raccoon-template.json` so the template path resolves relative to that profile. Then run:

    assetforge rig --model c3.glb --provenance c3/provenance.json --spec stevie-3d.json --profile profile.json

## Adding the reference frames

Add `"reference": "<dir of frames>"` to the walk gait in the profile (the path is relative to the profile). The walk is then rendered beside the reference frames, so the numbers can be tuned against them.
