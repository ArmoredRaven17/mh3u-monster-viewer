// Lens types (Raven, 2026-09-04: "lens types"). The orbit and the first-person controllers keep
// driving the master PerspectiveCamera; every lens renders the frame through a camera derived
// from it each frame, so framing, the clip planes and the light rig go on working on the
// master. Standard and tilt-shift use the master itself. Orthographic is a parallel camera
// whose half-height is the master's distance to its target times tan(fov / 2), so the frame
// keeps its size at the switch and the wheel still zooms through the distance. Fisheye
// renders a wider rectilinear source (up to 160 degrees) that render/fx.js remaps to an
// equidistant projection; anything past 160 would need a cubemap and is not offered.
// Anamorphic widens the horizontal field by the squeeze and renders a strip of the canvas's
// width and height / squeeze, drawn centred with transparent bars.
import * as THREE from 'three';

export const LENS_TYPES = ['standard', 'fisheye', 'ortho', 'anamorphic', 'tiltshift'];
export const LENS_DEFAULT = { type: 'standard', view: 120, squeeze: 1.5, band: 0.3, bandY: 0.5 };
export const SQUEEZES = [1.33, 1.5, 2];

const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
const persp = new THREE.PerspectiveCamera(38, 1, 0.001, 5000);

// the rectilinear source a fisheye view is remapped from: a little wider than the view, and
// never past 160 degrees, where a flat projection stops being usable
export function fovSrcOf(view){ return Math.min(160, view * 1.15); }

// the camera a frame is rendered through, for the lens
export function renderCameraFor(master, lens, dist, aspect){
  if (!lens || lens.type === 'standard' || lens.type === 'tiltshift') return master;
  if (lens.type === 'ortho'){
    const h = Math.max(1e-3, dist) * Math.tan(THREE.MathUtils.degToRad(master.fov) / 2);
    ortho.position.copy(master.position); ortho.quaternion.copy(master.quaternion);
    ortho.left = -h * aspect; ortho.right = h * aspect; ortho.top = h; ortho.bottom = -h;
    ortho.near = 0.01; ortho.far = Math.max(50, dist * 20);
    ortho.updateProjectionMatrix(); ortho.updateMatrixWorld(true);
    return ortho;
  }
  persp.position.copy(master.position); persp.quaternion.copy(master.quaternion);
  persp.near = master.near; persp.far = master.far;
  if (lens.type === 'fisheye'){ persp.fov = fovSrcOf(lens.view); persp.aspect = aspect; }
  else { persp.fov = master.fov; persp.aspect = aspect * lens.squeeze; }      // anamorphic
  persp.updateProjectionMatrix(); persp.updateMatrixWorld(true);
  return persp;
}

// the composer's size for a lens, in CSS pixels: fisheye oversizes its source so the centre
// keeps its resolution after the remap (capped at 2x and at maxPx on the long side),
// anamorphic renders the strip
export function composerSizeFor(lens, w, h, pr, maxPx){
  if (lens && lens.type === 'fisheye'){
    const src = THREE.MathUtils.degToRad(fovSrcOf(lens.view)), view = THREE.MathUtils.degToRad(lens.view);
    let k = Math.min(2, Math.max(1, Math.tan(src / 2) / (view / 2)));
    k = Math.min(k, (maxPx || 4096) / (pr || 1) / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
  }
  if (lens && lens.type === 'anamorphic') return { w, h: Math.max(1, Math.round(h / lens.squeeze)), k: 1 };
  return { w, h, k: 1 };
}
