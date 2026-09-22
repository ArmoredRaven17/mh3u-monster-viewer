// The stage: renderer, scene, camera, orbit controls and the studio light rig. Split out of
// index.html unchanged -- every constant here (FOV 38, the near/far planes, each light's
// colour, intensity and position, the damping, the auto-rotate speed) is exactly what the
// single script carried, and the lights are added in the same order so the shader sums them
// the same way. index.html keeps the camera bar (orbit / pan lock, spin, fit) and drives
// `controls` directly.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// createStage(viewportEl, { margin, pixelRatio })
//   -> { renderer, scene, camera, controls, lights: { hemi, key, rim, fill, ambient, head },
//        fit(), margin }
export function createStage(viewportEl, opt){
  const margin = (opt && opt.margin !== undefined) ? opt.margin : 1.35;
  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
  renderer.setPixelRatio((opt && opt.pixelRatio) || Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewportEl.appendChild(renderer.domElement);

  // No scene background: the canvas is transparent and .content paints the backdrop in CSS, so
  // the stage can carry a texture (an opaque clear colour cannot) and a chroma key is exactly
  // the value CSS was given, with no colour-space conversion in between.
  const scene = new THREE.Scene(); scene.background = null;
  // Every model lives under `world`; the lights stay in `scene`. The group exists so the
  // whole model side could be transformed as one, and it is the identity: the glTF export
  // keeps the game's own coordinates (probe-handedness.py: every bone offset keeps its sign),
  // and rendering them as-is matches what Raven sees in game -- the Sword & Shield's sword is
  // in the LEFT hand, which is where the ROM chain puts it (player bone 8, x > 0 in bind
  // pose). An x-mirror was tried on 2026-09-03 on the assumption that the sword was
  // right-handed; that assumption was wrong, and no mirror is applied. `mirrorX: true` in the
  // options turns it back on for comparison only (three.js flips the winding for a
  // negative-determinant matrix, so culling would stay correct).
  const world = new THREE.Group(); world.name = 'world';
  if (opt && opt.mirrorX) world.scale.x = -1;
  scene.add(world);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.001, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.autoRotate = false; controls.autoRotateSpeed = 1.8;

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x30281f, 1.4); scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.3); key.position.set(3,5,4); scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 1.1); rim.position.set(-4,2,-5); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.55); fill.position.set(0,-3,2); scene.add(fill);
  const ambient = new THREE.AmbientLight(0xffffff, 0.55); scene.add(ambient);
  // headlight: follows the camera so whatever you orbit to stays readable -- the render loop
  // copies camera.position into it every frame
  const head = new THREE.DirectionalLight(0xffffff, 0.9); scene.add(head);

  // size to the CONTENT area, not the window -- there is a 300px sidebar now.
  // `fixedSize: [w, h]` (the dev scene harness) renders at exactly that size whatever the
  // pane is, scaled to fit on screen, so shots are comparable across windows and machines.
  const fixed = opt && opt.fixedSize;
  function fit(){
    if (fixed){
      renderer.setSize(fixed[0], fixed[1], false);
      renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
      renderer.domElement.style.objectFit = 'contain';
      camera.aspect = fixed[0] / fixed[1];
      camera.updateProjectionMatrix();
      return;
    }
    const w = viewportEl.clientWidth || 1, h = viewportEl.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return { renderer, scene, world, camera, controls,
           lights: { hemi, key, rim, fill, ambient, head }, fit, margin };
}
