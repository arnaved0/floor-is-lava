# The Floor Is Lava

A third-person 3D browser game built with Three.js. You play as a 3D scan of yourself, hop across rock pillars over a sea of lava, and collect apples.

## Play locally

```bash
npm install
npm run dev      # dev server
npm run build    # static build in dist/
```

`dist/` is a static site (relative paths), so you can host it on GitHub Pages, Netlify, Vercel, itch.io, or any static file host. A GitHub Pages workflow is in `.github/workflows/deploy.yml`.

## Controls

| Key | Action |
| --- | --- |
| W A S D | Move (camera-relative) |
| Mouse | Orbit camera (click the game to capture the mouse) |
| Space | Jump |
| Shift | Sprint |
| Ctrl (hold) / C (toggle) | Crouch: slow, and you can't walk off ledges |
| Q | Dodge roll |
| E | Wave |
| Mouse wheel | Zoom |
| M | Mute |
| Esc | Pause |

> In Chrome/Edge, Ctrl+W normally closes the tab. With the "Play fullscreen" option on, the game uses the Keyboard Lock API so Ctrl+W crouch-walks instead. Outside fullscreen, use **C** to crouch.

## Gameplay

- Touching lava costs a life (3 per game). You respawn on the last safe rock you stood on.
- 🍎 Apple = 10 points. Golden apple = 50 points. Golden apples sit on moving platforms (blue rim) and on the tallest pillars.
- 🍑 Every apple makes your character's glutes inflate a little, round in every direction like a balloon: about 0.7 cm per apple and 2.4 cm per golden apple, up to +24 cm after about 33 apples. The growth has a springy wobble, and it resets when you start a new game, not between rounds. It works through a `glutes` blend shape (morph target) baked into `player.glb` by `tools/rig.py`. Tune it with `GLUTE_PER_APPLE` / `GLUTE_PER_GOLDEN` in `src/player.js`.
- 🍑 The glutes jiggle with real spring physics (`src/jiggle.js`). Each cheek has its own spring driven by the measured acceleration of that thigh in the animation, so they bounce out of sync when running, sway when turning, and slosh on landings. Bigger glutes jiggle more. Tune `ACCEL_GAIN` (strength), `FREQ` (wobble speed) and `ZETA` (how long it keeps wobbling).
- Red, glowing rock starts shaking when you land on it, sinks into the lava, and comes back after a few seconds.
- Collect every apple to clear the round. You get a bonus for time and remaining lives. Each round gets a new random layout with wider gaps, more crumbling rock and more moving platforms.
- Your best score is saved in the browser (localStorage).

## Assets

- **Player**: your avatar scan (`avatar.glb`), auto-rigged onto the Mixamo `mixamorig` skeleton with headless Blender (`tools/rig.py`). It uses Mixamo animations: Standing Idle, Walking, Running, Sprinting, Crouching Idle, Sneaking (crouch walk), Jumping, Falling Idle, Landing, Roll and Waving. The clips come from the MIT-licensed repos [kirbycope/godot-3d-player-controller](https://github.com/kirbycope/godot-3d-player-controller) and [nicholas-maltbie/OpenKCC](https://github.com/nicholas-maltbie/OpenKCC). Mixamo animations are free to use in projects under Adobe's Mixamo terms.
- **Apple model**, **dark rock texture**, **Belfast Sunset sky HDRI**: [Poly Haven](https://polyhaven.com) (CC0).
- Lava, embers, volcanoes and all sound effects are generated in code.

## Re-rigging / adding animations

`tools/rig.py` runs inside Blender's Python (`pip install bpy`). It:
1. Loads the scan, scales it to 1.78 m and faces it down −Y like Mixamo.
2. Loads the Mixamo Y-Bot skeleton and rescales the bone chains to the scan's proportions. Bone orientations are kept, so Mixamo rotations still apply.
3. Poses a copy of the skeleton to match the scan's relaxed A-pose and computes bone-heat skin weights.
4. Bakes the mesh into the Mixamo T-pose, binds it, imports every clip as an NLA track, and exports `player.glb`.

Then compress it with `npx @gltf-transform/cli optimize in.glb public/models/player.glb --compress meshopt --texture-compress webp --texture-size 2048`.

For best results you can also upload `avatar.glb` (as FBX/OBJ) to mixamo.com, auto-rig it there, download the clips "With Skin", and put them through the same script.
