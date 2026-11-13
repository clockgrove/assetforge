# Generic 3D renders for the identity set (assetforge#82, Outcome 9)

These five renders are the 3D `generic` cases of the identity acceptance set (`test/fixtures/identity-set/lookdev.ts`). Each is a negative against every Raccoon World cast member, as the 2D generics are.

They come from one real `assetforge look-dev` run, remade on 2026-11-12 for assetforge#122 so the generics share the second pass's preview lighting with Stevie's renders. It ran on Stevie's picked model (clockgrove/raccoon-world `assets/models/stevie/stevie.glb`, sha256 `81e5ece4…ef3f`), with a generic subject in place of Stevie:

- the bible's only subject was `generic-raccoon`: "an ordinary raccoon with a pale, silvery coat and a narrow eye mask, not any particular named character";
- its one reference was the set's 2D generic `test/fixtures/identity-set/generated/generic-silver-front.png`;
- the bible's other fields and the profile were raccoon-world's (`main` at e113a72), as for Stevie's run.

The run spent $0.20 of its $3.00 cap. Every check passed, `lookdev-markings` included; the identity lock scored the generic against its own reference in shadow mode (0.75). The renders are the summer coat's front, three-quarter, side and back turntable views and the close-up. #82's generic renders were made under the old turntable lighting and are replaced.

Only the surface is generic. The mesh, and so the proportions, are Stevie's: no other raccoon has a 3D model yet, and look-dev never regenerates a mesh. The cast question can still tell them apart by the markings and coat. A generic with its own mesh, and 3D look-alikes, wait for other characters' models.
