# MH3U Monster Viewer

A fan-made 3D viewer for the monsters of Monster Hunter 3 Ultimate (3DS). Pick a monster and
watch its own animations, with the game's own models and textures.

**Basic version, not published.** Forked from the MHGU Monster Viewer (commit `9329e19`) and cut
down to monster rendering and animation; hit zones come next, once their files are decoded.
Lighting, camera and effects panels are not part of it.

## What it does

- Every monster in the game with a model and motion lists: 77 of the 85 enemy archives (the
  seven boulder props and the fish have no animation or no model and are not listed)
- The monster's own motion lists, clip by clip, with looping and frame-by-frame stepping
- The game's own base textures, bound to each material by the game's own material files,
  including which materials are additive or alpha-blended
- The severed tails and other detachable pieces the game ships as separate models

**Lighting is generic three.js lighting, not the game's.** MH3U's shading (its material
constants, normal maps and the 3DS lighting lookup tables) is not decoded, so none of it is
imitated.

## Running it

No build step. Serve `docs/` with any static file server:

    python dev/serve.py 5590

## Contents

    docs/index.html        the app: markup, styles and logic
    docs/monsters.json     per monster: model, pieces, motion lists; `_about` says what is
                           read from the game and what is not decoded yet
    docs/materials.json    each material's base texture and blend state, from its .mrl
    docs/models/monsters/  one glb per model (the monster, and its severed pieces)
    docs/poses/monsters/   one glb per motion list, animations only
    docs/tex/              textures, deduplicated by content hash
    docs/render/           the render core, copied from the MHGU Monster Viewer

## Where the data comes from

The scripts live beside this repository in `C:\MH3U-Extract` and read a decrypted cart image:

    unpack_cci.py        the cart image -> exheader, ExeFS (the ARM11 code) and RomFS
    arc_extract.py       every ARC v16 archive, one folder per archive
    convert_monsters.py  RevilToolset (`--title mh3 --platform N3DS`): models, textures,
                         motion lists, each checked against its own source header
    build_viewer.py      everything under docs/ (skins merged, proxies hidden, poses thinned)

Neither the extract nor the game's files are part of this repository.

## Credits

See NOTICE.md, and the About dialog in the app.

Monster Hunter 3 Ultimate is © CAPCOM CO., LTD. This is an unofficial fan project and is not
affiliated with or endorsed by Capcom.
