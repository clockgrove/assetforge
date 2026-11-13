# Generic 3D renders for the identity set (assetforge#82, Outcome 9)

These five renders are the 3D `generic` cases of the identity acceptance set (`test/fixtures/identity-set/lookdev.ts`). Each is a negative against every Raccoon World cast member, as the 2D generics are.

They come from one real `assetforge look-dev` run, made on 2026-11-12 on Stevie's picked model (clockgrove/raccoon-world `assets/models/stevie/stevie.glb`, sha256 `81e5ece4…ef3f`), with a generic subject in place of Stevie:

- the bible's only subject was `generic-raccoon`: "an ordinary raccoon with a pale, silvery coat and a narrow eye mask, not any particular named character";
- its one reference was the set's 2D generic `test/fixtures/identity-set/generated/generic-silver-front.png`;
- the identity lock was off, since the subject has no lock.

The run spent $0.21 of its $3.00 cap. Every deterministic check passed. The renders are the summer coat's front, three-quarter, side and back turntable views and the close-up.

Only the surface is generic. The mesh, and so the proportions, are Stevie's: no other raccoon has a 3D model yet, and look-dev never regenerates a mesh. The cast question can still tell them apart by the markings and coat. A generic with its own mesh, and 3D look-alikes, wait for other characters' models.
