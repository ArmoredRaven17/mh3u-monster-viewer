// Monsters (arc/enemy): the model, its materials and the part-visibility groups, read from
// docs/monsters.json and docs/materials.json; the clips are played by render/pose.js on a clone of
// the model itself (the motion files ship nodes and animations only). Also the hit-zone heat map and
// capsules, drawn from the optional docs/hitzones.json.
//
// MH3U's shading is NOT decoded. Every mesh takes material.js's createMaterial with its albedo and
// blend state from materials.json; no normal, specular or sphere map is bound, and nothing here
// stands in for the game's own shader.
//
//   parts   the mesh table's draw mask marks the proxy layer, listed per model as `hideIdx`; the
//           part-visibility groups (monsters.json `groups`) switch the rest -- MH3U ships none yet
import * as THREE from 'three';
import { loadGlb, getTexture, loader, poseCache, bust } from './assets.js';
import { skeletonClone, meshGroupId, gidBonesOf } from './skeleton.js';
import { createMaterial, allMats } from './material.js';
import { specFor, refForGlb } from './materials-db.js';

// every material a monster mesh was given (the debug knobs walk this)
export const monsterMats = [];

// Unmounting a monster has to give its materials back: both registries are plain arrays that would
// otherwise only grow, a wireframe toggle would walk materials nobody can see, and the GPU would keep
// every shader program alive. Textures are NOT disposed: the asset cache shares them between monsters.
export function releaseMonster(root){
  if (!root) return;
  const mine = new Set(root.userData.mats || []);
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    if (o.material) mine.add(o.material);
    if (o.geometry) o.geometry.dispose();
  });
  for (const m of mine){
    let i = monsterMats.indexOf(m); if (i >= 0) monsterMats.splice(i, 1);
    i = allMats.indexOf(m); if (i >= 0) allMats.splice(i, 1);
    m.dispose();
  }
}

// ---- part visibility ------------------------------------------------------------------------
// The part table lists groups of { part, drawn }. Groups over the SAME part set are alternatives of
// one swap (an intact part against the broken one that replaces it), so they are clustered by the set
// of parts they name, wherever they sit in the table -- a repeat of a set away from its first
// appearance is the same cluster, not a new one.
export function clusterGroups(groups){
  const order = [], byKey = new Map();
  (groups || []).forEach((g, i) => {
    const key = g.map(e => e[0]).sort((a, b) => a - b).join(',');
    let c = byKey.get(key);
    if (!c){ c = { parts: key, members: [] }; byKey.set(key, c); order.push(c); }
    c.members.push(i);
  });
  return order;
}
// part -> drawn, from the groups switched on, applied in order (a later group wins)
export function partsDrawn(groups, on){
  const drawn = new Map();
  (groups || []).forEach((g, i) => { if (on && on[i]) for (const [p, v] of g) drawn.set(p, v); });
  return drawn;
}
// a part no group mentions stays drawn; the proxy layer never draws
export function applyParts(root, drawn){
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh) || o.userData.proxy) return;
    const v = drawn.get(o.userData.part);
    o.visible = (v === undefined) ? true : v;
  });
}
export function groupLabel(g){
  const on = g.filter(e => e[1]).map(e => e[0]), off = g.filter(e => !e[1]).map(e => e[0]);
  return (on.length ? 'on ' + on.join(', ') : '') + (on.length && off.length ? '  /  ' : '') + (off.length ? 'off ' + off.join(', ') : '');
}

// ---- borrowed motion lists -------------------------------------------------------------------
// A monster may play another monster's motion list. The file is converted onto its OWNER's model, so
// its tracks carry the owner's node names, "<localIndex>:<globalBoneId>" -- and three.js STRIPS the
// colon, so "10:6" and "1:06" both arrive as "106" and the id cannot be worked out here. The build
// therefore ships a borrowed list's `remap` (sanitised name -> sanitised name) and each track is
// renamed onto this model; a bone the borrower does not have is dropped, as the game ignores it. A list
// with no `remap` (every MH3U list today, `shared: false`) plays as it is.
export async function clipFor(list, clipName, modelUrl){
  let anim = poseCache.get('anim:' + list.file);
  if (!anim){ anim = await loader.loadAsync(bust(list.file)); poseCache.set('anim:' + list.file, anim); }
  const src = THREE.AnimationClip.findByName(anim.animations, clipName);
  if (!src) return null;
  const remap = list.remap;
  if (!remap || !Object.keys(remap).length) return src;
  const key = 'retarget:' + modelUrl + ':' + list.file + ':' + clipName;
  const cached = poseCache.get(key);
  if (cached) return cached;
  const model = await loadGlb(modelUrl, modelUrl);
  const have = new Set();
  model.scene.traverse(o => { if (o.name) have.add(o.name); });
  const out = src.clone(), keep = [];
  let moved = 0, lost = 0;
  for (const t of out.tracks){
    const dot = t.name.lastIndexOf('.');
    const node = t.name.slice(0, dot), prop = t.name.slice(dot);
    if (have.has(node)){ keep.push(t); continue; }
    let want = remap[node];
    // THE "_s" TWINS: `remap` names the base bones only, and a leaf follows its base bone's local-index
    // change exactly -- so the mapping is the base's with the suffix put back. They carry the joint SCALE
    // tracks, which the pose driver applies.
    if (!want && node.endsWith('_s')){
      const base = remap[node.slice(0, -2)];
      if (base) want = base + '_s';
    }
    if (want && have.has(want)){ t.name = want + prop; moved++; keep.push(t); }
    else lost++;
  }
  out.tracks = keep;
  out.userData = { retargeted: moved, unresolved: lost };
  poseCache.set(key, out);
  return out;
}

// ---- the model ------------------------------------------------------------------------------
// rec: a model record of monsters.json (the monster itself, or one of its `parts`). ctx: { wire }
export async function loadMonster(rec, ctx){
  const gltf = await loadGlb(rec.glb, rec.glb);
  const root = skeletonClone(gltf.scene);
  // WHICH PRIMITIVES ARE THE PROXY LAYER, by ordinal in the file's own order (the build computes it
  // against the model's draw mask). The older `hide` list of [part, vertexCount] signatures is only the
  // fallback: it hides real geometry wherever a drawn mesh shares a part and a vertex count with a proxy.
  const hideIdx = new Set(rec.hideIdx || []);
  const hideSig = rec.hideIdx ? null : new Set((rec.hide || []).map(h => h[0] + '#' + h[1]));
  let prim = -1;
  const ref = refForGlb(rec.glb);
  const jobs = [], mats = [];
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    const srcName = (o.material && o.material.name) || '';
    const verts = o.geometry.attributes.position.count;
    const part = meshGroupId(o);
    o.userData.part = part;
    o.frustumCulled = false;              // bind-pose bounds, which a skinned clip leaves behind
    prim++;
    o.userData.prim = prim;
    // MARKED, NOT SKIPPED: a mask-hidden mesh still gets its material, so the Debug panel's Draw
    // Mask-Hidden Meshes shows it as it would draw rather than in the loader's default grey.
    if (hideIdx.has(prim) || (hideSig && hideSig.has(part + '#' + verts))){
      o.visible = false; o.userData.proxy = true;
    }
    const rom = specFor(ref, srcName);
    // A mesh whose material the game's own material file does not define: the exporter names it
    // "Scene_Material" and there is nothing to bind. The Debug panel's Draw Undefined Meshes decides.
    if (!rom && /^Scene_Material$/i.test(srcName)) o.userData.undefinedMaterial = true;
    // material.js's createMaterial, handed the materials.json record as `rom`: its blend state picks the
    // lit path, the alpha-blended one or the additive one, and the albedo below is all that is bound.
    const mat = createMaterial({ srcName, rom, alphaCut: 0, noTint: true,
                                 unlit: !!(rom && rom.cls && rom.cls !== 'Std'),
                                 wire: !!(ctx && ctx.wire) });
    o.material = mat; allMats.push(mat); monsterMats.push(mat); mats.push(mat);
    if (mat.userData.renderOrder) o.renderOrder = mat.userData.renderOrder;
    // The albedo alone. MH3U's shading is undecoded, so no normal, specular or sphere map is bound.
    if (rom && rom.albedo) jobs.push(getTexture(rom.albedo).then(t => {
      mat.map = t; if (mat.userData.emissiveFromMap) mat.emissiveMap = t;
      mat.needsUpdate = true; }));
  });
  await Promise.all(jobs);
  root.userData.joints = rec.joints || [];
  root.userData.mats = mats;
  // The pose driver writes bone transforms straight onto these nodes, so once a clip has played
  // nothing remembers the rest pose. Snapshot it here; the Clip select's "Bind pose" restores it.
  root.userData.bind = [];
  root.traverse(o => root.userData.bind.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  return root;
}

// The meshes the model's own draw mask holds back (the proxy layer). A looking tool: it says nothing
// about whether they SHOULD draw, only what is being withheld.
export function setProxyVisible(root, on){
  root.traverse(o => { if (o.userData && o.userData.proxy) o.visible = !!on; });
}
export function proxyCount(root){
  let n = 0;
  root.traverse(o => { if (o.userData && o.userData.proxy) n++; });
  return n;
}

// Show or hide the meshes whose material the game's own material file does not define.
export function setUndefinedMaterialVisible(root, on){
  root.traverse(o => { if (o.userData.undefinedMaterial) o.visible = !!on; });
}

// put a mounted monster back exactly as it loaded, so "Bind pose" can actually return to it
export function restoreBind(root){
  for (const [node, p, q, sc] of (root && root.userData.bind) || []){
    node.position.copy(p); node.quaternion.copy(q); node.scale.copy(sc);
  }
}

// ---- hit-zone heat map ---------------------------------------------------------------------
// Every drawn vertex carries a hit-zone slot, baked by the build from the nearest hit-zone capsule; the
// slot indexes the monster's damage table (cut, impact, shot, fire, water, ice, thunder, dragon, stun,
// exhaust). Higher means the zone takes more damage.
const heatSaved = new WeakMap();

// Blue is tough, red is soft. A plain hue sweep reads better here than a perceptual ramp
// because the eye needs to rank regions, not read absolute numbers off them.
export function heatColor(t){
  t = Math.max(0, Math.min(1, t));
  const stops = [[0.05, 0.13, 0.42], [0.13, 0.45, 0.70], [0.35, 0.72, 0.62],
                 [0.85, 0.83, 0.35], [0.90, 0.52, 0.20], [0.75, 0.14, 0.16]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return [stops[i][0] + (stops[i+1][0] - stops[i][0]) * f,
          stops[i][1] + (stops[i+1][1] - stops[i][1]) * f,
          stops[i][2] + (stops[i+1][2] - stops[i][2]) * f];
}

// Gap detection: every mesh flat-shaded in ONE colour, unlit. Against a chroma backdrop a hole in
// the model shows as backdrop-coloured pixels inside the silhouette. It borrows the heat map's own
// save/restore, so clearHeatmap puts the real materials back.
export function applyFlat(root, rgb, THREE){
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    // Already flat: just recolour it. The theme and backdrop can change while this is on, and
    // building a new material each time would leak one per change.
    if (o.material && o.material.name === 'flat'){
      o.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
      return;
    }
    if (!heatSaved.has(o)) heatSaved.set(o, { mat: o.material, col: o.geometry.getAttribute('color') || null });
    o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb[0], rgb[1], rgb[2]),
                                               side: o.material.side, name: 'flat' });
  });
}
// zones: { primOrdinal: Uint8Array of slot per vertex }. value: slot -> number, scaled by max through
// the ramp. colorBySlot: slot -> [r,g,b], used literally and taking precedence. A slot in neither comes
// out at the ramp's floor.
export function applyHeatmap(root, zones, value, max, THREE, colorBySlot){
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    const z = zones[o.userData.prim];
    if (!z) return;
    const n = o.geometry.attributes.position.count;
    if (z.length !== n) return;                 // the bake and the file disagree: leave it alone
    if (!heatSaved.has(o)) heatSaved.set(o, { mat: o.material, col: o.geometry.getAttribute('color') || null });
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++){
      const sl = z[i];
      const c = colorBySlot ? (colorBySlot[sl] || [0.10, 0.11, 0.13])
                            : heatColor(value[sl] === undefined ? 0 : value[sl] / (max || 1));
      col[i*3] = c[0]; col[i*3+1] = c[1]; col[i*3+2] = c[2];
    }
    o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: o.material.side,
                                            name: 'heat:' + (o.material.name || '') });
    o.material = m;
  });
}

export function clearHeatmap(root){
  root.traverse(o => {
    const sv = heatSaved.get(o);
    if (!sv) return;
    if (o.material && /^heat:/.test(o.material.name || '')) o.material.dispose();
    o.material = sv.mat;
    if (sv.col) o.geometry.setAttribute('color', sv.col);
    else o.geometry.deleteAttribute('color');
    heatSaved.delete(o);
  });
}

// <em>.bin: u32 primCount, primCount x u32 vertexCount, then the slot bytes in primitive order: one
// block of damage-table slots, one byte per vertex, and where the bake wrote one a second equal block
// of part-record indices (returned as `parts`, null when the bin has none).
export function parseZones(buf, prims){
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true);
  const counts = [];
  for (let i = 0; i < n; i++) counts.push(dv.getUint32(4 + i*4, true));
  const head = 4 + n*4;
  const total = counts.reduce((a, b) => a + b, 0);
  const hasParts = buf.byteLength >= head + total * 2;
  const slots = {}, parts = {};
  let off = head, poff = head + total;
  for (let i = 0; i < n; i++){
    slots[prims[i]] = new Uint8Array(buf, off, counts[i]);
    if (hasParts) parts[prims[i]] = new Uint8Array(buf, poff, counts[i]);
    off += counts[i]; poff += counts[i];
  }
  return hasParts ? { slots, parts } : { slots, parts: null };
}

// ---- a hit zone as the game defines it ------------------------------------------------------------
// The heat map is a BAKE: every vertex carries ONE capsule's slot, by a rule the build chose, so it can
// show a zone only as the share of the surface it won. What the game defines is the hit-zone record: a
// sphere or a capsule hung off one or two joints, carrying the damage-table row it reports and the part
// record. hitzones.json's `capsules` are those records, unbaked, and this draws them.
//
// A point is its joint's world matrix applied to point / 100, and the radius is radius / 100 in glb
// units --
//     shape 0  a sphere at A on boneA        shape 1  A..B, both in boneA's space
//     shape 2  A in boneA's space, B in boneB's
// The joint matrices are the POSED ones, so a capsule rides its joints through a clip. Any other shape,
// or a bone the model does not carry, is counted and left out, not guessed.
//
// Each capsule is drawn twice off one set of placement uniforms: a faint pass that ignores depth, so a
// zone inside the body still shows, and a stronger depth-tested pass. The shape is made in the vertex
// shader from a unit CapsuleGeometry -- the top cap's vertices go to B, the bottom cap's to A -- so a
// capsule spanning two joints stretches with them and nothing is rebuilt per frame.
const ZONE_VS = `
uniform vec3 uA;
uniform vec3 uB;
uniform float uR;
uniform mat3 uBasis;
varying vec3 vN;
varying vec3 vV;
void main(){
  bool top = position.y > 0.0;
  vec3 local = position - vec3(0.0, top ? 0.5 : -0.5, 0.0);
  vec3 world = (top ? uB : uA) + uBasis * (local * uR);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vN = normalize(mat3(viewMatrix) * (uBasis * normal));
  vV = projectionMatrix[3][3] == 1.0 ? vec3(0.0, 0.0, 1.0) : -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const ZONE_FS = `
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main(){
  float edge = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  gl_FragColor = vec4(min(uColor * (0.8 + 0.6 * edge), vec3(1.0)), uAlpha * (0.35 + 0.65 * edge * edge));
}`;
// THE CAPSULE COLOUR IS NOT THE THEME'S, so no theme can put it on a heat-map colour. A fixed list to
// pick from, and Auto, which takes the colour that stands out on the heat map being drawn: magenta over
// the damage ramp, white with no heat map on.
export const ZONE_CAPSULE_COLOURS = [
  { key: 'white',   name: 'White',   rgb: [1.0, 1.0, 1.0] },
  { key: 'magenta', name: 'Magenta', rgb: [1.0, 0.0, 1.0] },
  { key: 'cyan',    name: 'Cyan',    rgb: [0.0, 1.0, 1.0] },
  { key: 'violet',  name: 'Violet',  rgb: [0.733, 0.0, 0.8] },
  { key: 'pink',    name: 'Pink',    rgb: [1.0, 0.2, 0.6] },
  { key: 'lime',    name: 'Lime',    rgb: [0.5, 1.0, 0.0] },
];
export const ZONE_CAPSULE_AUTO = 'auto';
const ZONE_AUTO_BY_MAP = { none: 'white', damage: 'magenta' };
const ZONE_CAPSULE_RGB = ZONE_CAPSULE_COLOURS[0].rgb;
// choice: a ZONE_CAPSULE_COLOURS key, or anything else for Auto. heat: the heat map on screen, '' for none.
// Returns { key, rgb } -- the colour drawn.
export function zoneCapsuleColour(choice, heat){
  let c = ZONE_CAPSULE_COLOURS.find(x => x.key === choice);
  if (!c) c = ZONE_CAPSULE_COLOURS.find(x => x.key === ZONE_AUTO_BY_MAP[heat ? 'damage' : 'none']);
  return { key: c.key, rgb: c.rgb.slice() };
}
// records: hitzones.json capsule rows [slot, part, shape, boneA, boneB, radius, ax, ay, az, bx, by, bz].
// opts.color: [r, g, b] 0..1, written as given. Returns a Group for the scene (not the monster, so no
// traversal of the model meets it), with userData.placed / skipped, readback() and dispose().
export function zoneCapsules(root, records, opts = {}){
  const group = new THREE.Group();
  group.name = 'zone-capsules';
  const bones = new Map();
  for (const b of gidBonesOf(root)) bones.set(b.gid, b.leaf || b.node);
  const geo = new THREE.CapsuleGeometry(1, 1, 6, 24);
  const rgb = opts.color || ZONE_CAPSULE_RGB;
  const color = { value: new THREE.Vector3(rgb[0], rgb[1], rgb[2]) };
  const mats = [], live = [];
  const s = new THREE.Vector3(), y = new THREE.Vector3(), x = new THREE.Vector3(), z = new THREE.Vector3();
  let skipped = 0;
  for (const c of records || []){
    const [slot, part, shape, a, b, r, ax, ay, az, bx, by, bz] = c;
    const ja = bones.get(a), jb = shape === 2 ? bones.get(b) : ja;
    if (!(shape === 0 || shape === 1 || shape === 2) || !ja || !jb){ skipped++; continue; }
    const u = { uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uR: { value: 0 },
                uBasis: { value: new THREE.Matrix3() }, uColor: color };
    const la = new THREE.Vector3(ax, ay, az).multiplyScalar(0.01);
    const lb = new THREE.Vector3(bx, by, bz).multiplyScalar(0.01);
    const place = () => {
      u.uA.value.copy(la).applyMatrix4(ja.matrixWorld);
      if (shape === 0) u.uB.value.copy(u.uA.value);
      else u.uB.value.copy(lb).applyMatrix4(jb.matrixWorld);
      u.uR.value = r * 0.01 * s.setFromMatrixColumn(root.matrixWorld, 0).length();
      y.subVectors(u.uB.value, u.uA.value);
      const len = y.length();
      if (len < 1e-6) y.set(0, 1, 0); else y.divideScalar(len);
      x.set(Math.abs(y.y) < 0.99 ? 0 : 1, Math.abs(y.y) < 0.99 ? 1 : 0, 0).cross(y).normalize();
      z.crossVectors(x, y);
      u.uBasis.value.set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
    };
    // the faint pass through the body first, then the surface pass over it
    for (const [through, alpha, order] of [[true, 0.2, 9000], [false, 0.5, 9001]]){
      const m = new THREE.ShaderMaterial({ vertexShader: ZONE_VS, fragmentShader: ZONE_FS,
        uniforms: Object.assign({ uAlpha: { value: alpha } }, u),
        transparent: true, depthWrite: false, depthTest: !through, side: THREE.FrontSide });
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;             // the vertex shader places it; the geometry's bounds are the unit capsule
      mesh.renderOrder = order;
      // placed as the renderer reaches it, after the frame's world matrices -- the posed joints -- are current
      if (through) mesh.onBeforeRender = place;
      mats.push(m);
      group.add(mesh);
    }
    live.push({ slot, part, shape, a, b, u, place });
  }
  group.userData.placed = live.length;
  group.userData.skipped = skipped;
  // placed afresh from the joints' current world matrices, so it answers with nothing being rendered
  group.userData.readback = () => live.map(l => (l.place(), { slot: l.slot, part: l.part, shape: l.shape, a: l.a, b: l.b,
    A: l.u.uA.value.toArray().map(v => +v.toFixed(3)), B: l.u.uB.value.toArray().map(v => +v.toFixed(3)),
    r: +l.u.uR.value.toFixed(3) }));
  group.userData.setColor = c => { if (c) color.value.set(c[0], c[1], c[2]); };
  group.userData.getColor = () => color.value.toArray().map(v => +v.toFixed(3));
  group.userData.dispose = () => { geo.dispose(); for (const m of mats) m.dispose(); };
  return group;
}
