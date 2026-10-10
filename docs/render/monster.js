// Monsters (arc/enemy): the model, its materials and the part-visibility table, read from
// docs/monsters.json and docs/materials.json; the clips are played by render/pose.js on a clone of
// the model itself (the motion files ship nodes and animations only). Also the hit-zone heat map and
// capsules, drawn from the optional docs/hitzones.json.
//
// MH3U's LIGHTING is not decoded. Every mesh takes material.js's createMaterial with its albedo and
// the game's own render state from materials.json -- blend, depth write, cull, depth bias -- then
// romConstants applies the colour, transparency and alpha test its constant buffers and record give.
// No normal, specular or sphere map is bound, and the lighting is generic.
//
//   parts   the mesh table's draw mask marks the proxy layer, listed per model as `hideIdx`; the
//           ROM's parts table (monsters.json `partTable`, see partDrawnRom) switches the rest
import * as THREE from 'three';
import { loadGlb, getTexture, loader, poseCache, bust } from './assets.js';
import { skeletonClone, meshGroupId, gidBonesOf } from './skeleton.js';
import { createMaterial, allMats } from './material.js';
import { specFor, refForGlb, texturesFor } from './materials-db.js';

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

// ---- part visibility: the ROM's parts table ---------------------------------------------------
// 3U has no part file. Each enemy's table sits in the executable (mh3u_parts.py has the read:
// 0xc1c008[em] -> record + 0x90, 0x14-byte rows) and uEnemy re-applies it every frame
// (0x82ebd4 -> 0x5c5568 -> 0x852118). monsters.json `partTable` carries the rows as
// [part, group, cond, mode, param, threshold]; group 255 is the monster's own model, n the severed
// piece whose `group` is n. A part no row names stays drawn, as in the game.
export const PART_MAIN = 255;

// 0x852118's condition switch. st: { eyes, cut, state3, variant, breaks: {record: count}, bits795,
// flag954, bitsafd, cls: {cond: 0|1} } -- the fields of the enemy's status block the rows read, and from
// 100 up the class inputs of monsters.json `partCode` (mh3u_parts_class.py).
export function partCond(cond, param, thr, st){
  switch (cond){
    case 0: return !!st.eyes;                                    // +0x796, the blink / eyes-closed flag
    case 1: return ((param & 0xffff) & (st.cut | 0)) !== 0;      // +0x8b6, severed-piece bits
    case 3: return !!st.state3;                                  // +0xdc == 2 or +0x140 bit 0
    case 4: return (st.variant | 0) === param;                   // +0xa, the spawn variant
    case 5: return (param & ~(st.variant | 0)) === 0;
    case 6: return ((st.breaks || {})[param & 0xff] | 0) >= thr;  // break count of record param
    case 7: return ((st.bits795 | 0) & param) !== 0;             // +0x795, per-monster appearance bits
    case 8: return (st.flag954 | 0) === 1;                       // +0x954
    case 9: return ((st.bitsafd | 0) & param) !== 0;             // +0xafd
    default: return cond >= 100 ? classCond(cond, st) : false;    // 2 and 10..99: never
  }
}
// a class input (partCode.conds): a switch of its own, a test of a valued input, or an OR of others
function classCond(cond, st){
  const d = (st.code && st.code.conds && st.code.conds[String(cond)]) || {};
  if (Array.isArray(d.any)) return d.any.some(x => partCond(x, 0, 0, st));
  if (d.input !== undefined){
    const v = (st.inputs || {})[d.input] | 0;
    return d.op === 'eq' ? v === d.value : v !== d.value;
  }
  return !!(st.cls || {})[cond];
}
// 0x852118: the rows naming (part, group), in table order. Modes 0 and 1 decide (drawn = !c / c);
// mode 2 hides on c and mode 3 hides on !c, otherwise the next row decides; past the last, drawn.
export function partDrawnRom(rows, part, group, st){
  for (const [p, g, cond, mode, param, thr] of rows || []){
    if (p !== part || g !== group) continue;
    const c = partCond(cond, param, thr, st);
    if (mode === 0) return !c;
    if (mode === 1) return c;
    if (mode === 2){ if (c) return false; continue; }
    if (mode === 3){ if (!c) return false; continue; }
    return true;
  }
  return true;
}
// One control per input the rows read, in first-appearance order. Every control starts at the value
// the game spawns with (0x83529c..0x8353a8 clears +0x794..0x796; break counts, cut bits and the rest
// start at 0). `pieces` are the monster's severed models, `code` the monster's partCode, whose rows
// read the same inputs plus class inputs (cond >= 100) described in code.conds.
//
// A ROW IS NAMED BY THE PART IDS IT SWITCHES, and an item by the ids it draws -- Raven, 2026-09-22:
// "Can you revert the part names back to part ids. I will need to manually assign and arrange the
// drop downs and their items". What the ROM reads for a row is kept in `rom`, which the panel hangs on
// the row as its tooltip, so naming has the source to hand without the label claiming one.
export function partControls(table, pieces, code){
  const rows = (table || []).concat(code ? code.rows : []);
  const out = [], by = new Map();
  const get = (key, make) => {
    let c = by.get(key);
    if (!c){ c = Object.assign({ key, refs: [], value: 0 }, make()); by.set(key, c); out.push(c); }
    return c;
  };
  const hex = n => '0x' + n.toString(16);
  const pieceOf = g => (pieces || []).find(x => x.group === g);
  const on = [['Off', 0], ['On', 1]];
  const conds = (code && code.conds) || {}, inputs = (code && code.inputs) || {};
  const add = (part, group, cond, param, thr) => {
    let c = null;
    if (cond === 0) c = get('eyes', () => ({ values: [0, 1],
                                             rom: 'eyes-closed flag +0x796 (the blink)' }));
    else if (cond === 1){
      // +0x8b6 is a u16 of state bits. 0x82888c sets bit 0x1 / 0x2 / 0x4 when a part record whose sever
      // slot (+5) is 1 / 2 / 3 is cut off; the higher bits are the monster class's own states.
      const bit = param & 0xffff, sever = (bit & ~7) === 0;
      c = get('cut' + bit, () => ({ bit, values: [0, 1],
        rom: '+0x8b6 & ' + hex(bit) + (sever ? ' (a sever bit, set by 0x82888c)' : ' (a class state bit, meaning not read)') }));
      const pc = group === PART_MAIN ? null : pieceOf(group);
      if (sever && pc && !c.piece) c.piece = pc;
    }
    else if (cond === 3) c = get('state3', () => ({ values: [0, 1],
      rom: '+0xdc == 2 or +0x140 bit 0 (reads as water: 0x854784 pairs +0x140 bit 0 with a water-height test)' }));
    else if (cond === 4 || cond === 5){
      c = get('variant', () => ({ vals: new Set([0]), rom: 'spawn variant +0xa' }));
      c.vals.add(param);
    }
    else if (cond === 6){
      const rec = param & 0xff;
      c = get('break' + rec, () => ({ record: rec, vals: new Set([0]),
                                      rom: 'break count of record ' + rec + ' (+0x8b8 + 8n)' }));
      c.vals.add(thr);
    }
    else if (cond === 7) c = get('b795_' + param, () => ({ mask: param, values: [0, 1],
                                                             rom: '+0x795 & ' + hex(param) + ' (per-monster appearance bits)' }));
    else if (cond === 8) c = get('f954', () => ({ values: [0, 1],
      rom: '+0x954 == 1: the rage flag (0x8456f0 sets it with the rage timer +0x950; 0x82adb0 tests it)' }));
    else if (cond === 9) c = get('bafd_' + param, () => ({ mask: param, values: [0, 1],
                                                             rom: '+0xafd & ' + hex(param) + ' (meaning not read)' }));
    else if (cond >= 100){
      const d = conds[String(cond)] || {};
      // an OR adds a control for each of its members; a valued input is one control for all its tests
      if (Array.isArray(d.any)){ for (const x of d.any) add(part, group, x, 0, 0); return; }
      if (d.input !== undefined){
        const inp = inputs[d.input] || {};
        c = get('in_' + d.input, () => ({ input: d.input, values: (inp.options || on).map(o => o[1]),
                                          rom: (inp.rom || 'class code') + ' -- class code' }));
      }
      else c = get('c' + cond, () => ({ cond, values: (d.options || on).map(o => o[1]),
                                        rom: (d.rom || 'class code') + ' -- class code, not the parts table' }));
    }
    if (c && !c.refs.some(r => r.part === part && r.group === group)){
      const pc = group === PART_MAIN ? null : pieceOf(group);
      c.refs.push({ part, group, piece: pc ? pc.name : null });
    }
  };
  for (const [part, group, cond, , param, thr] of rows) add(part, group, cond, param, thr);
  for (const c of out){
    if (c.vals){ c.values = [...c.vals].sort((a, b) => a - b); delete c.vals; }
    // the row's name: the part ids it switches, each id once however many models carry it
    c.parts = [...new Set(c.refs.map(r => r.part))].sort((a, b) => a - b);
    c.label = 'Parts ' + c.parts.join(', ');
    const onPieces = [...new Set(c.refs.filter(r => r.piece).map(r => r.part + ' on ' + r.piece))];
    c.rom += onPieces.length ? ' -- ' + onPieces.join(', ') : '';
  }
  return out;
}
// What an item of a row draws: its own parts under that value, with every other row left as it is --
// a chained row (mode 2 / 3) reads more than one input, so its items only mean anything together.
export function optionParts(ctl, value, controls, values, table, code){
  const st = partStatus(controls, Object.assign({}, values, { [ctl.key]: value }), code);
  const on = [], off = [];
  for (const { part, group } of ctl.refs || []){
    const codeRows = code && code.rows.some(r => r[0] === part && r[1] === group) ? code.rows : table;
    (partDrawnRom(codeRows, part, group, st) ? on : off).push(part);
  }
  const uniq = a => [...new Set(a)].sort((x, y) => x - y);
  return { on: uniq(on), off: uniq(off) };
}
export function optionLabel(ctl, value, controls, values, table, code){
  const { on, off } = optionParts(ctl, value, controls, values, table, code);
  const text = (on.length ? 'on ' + on.join(', ') : '') + (on.length && off.length ? '  /  ' : '') +
               (off.length ? 'off ' + off.join(', ') : '');
  return text || String(value);
}

// ---- wing tears: an alpha-test reference, not a part ---------------------------------------------
// A torn wing is the SAME mesh with a higher alpha-test reference: the membrane's texture steps its
// alpha (Rathalos 0 / 85 / 102 / 255), and raising the ref from 20 to 127 cuts the 85 and 102 texels --
// the holes. The class's slot 55 writes it every frame through 0x84d678 (GEQUAL, PICA 0x104), the
// intact ref until the wing's break count reaches `min`, then the torn one, so the intact ref comes
// from the class too, not the .mrl. monsters.json `tears`: [{mat, rec, min, intact, torn}], `mat` the
// material NUMBER, which is the mNN in the material's name. GEQUAL is three.js' own alphaTest rule
// (discard a < alphaTest), so the ref goes in as ref / 255 with no epsilon.
const matNoOf = name => { const m = /(?:^|_)m0*(\d+)_/.exec(name || ''); return m ? +m[1] : -1; };
export function applyTears(root, tears, st){
  if (!root || !tears) return;
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.material) return;
    const mat = o.material, t = tears.find(x => x.mat === matNoOf(mat.name));
    if (!t) return;
    const torn = (((st && st.breaks) || {})[t.rec] | 0) >= t.min;
    const cut = (torn ? t.torn : t.intact) / 255;
    // the cutout flags material.js's alpha knob reads, so the knob's "ROM" setting returns here
    mat.userData.cutout = true; mat.userData.romCut = cut;
    mat.alphaTest = cut;
    if (mat.userData.u && mat.userData.u.uAlphaCut) mat.userData.u.uAlphaCut.value = 1;
  });
}

// ---- attached pieces ---------------------------------------------------------------------------
// A monster's piece model (em###_tail, _head, _horn) is NOT only a prop for after the cut: the game
// makes it at spawn, parents it to the monster (0x835464 -> vtable slot 18, 0x68612c, which stores
// parent + joint at piece+0x30) and skins it to the MONSTER's joints -- its bones carry the same
// global ids and its geometry starts where the body's stump cap sits. Drawn on its own the monster
// is missing the end of its tail: Rathalos' body stops at the cap and the piece carries the rest.
// Attaching is its own inverse bind matrices with the BODY's bones, so the body's pose drives it and
// the driver still only has the body to move. Both roots and bind matrices are identity, and in
// three.js 'attached' bind mode a mesh's own world matrix cancels out, so nothing else has to line up.
//
// The bones come from monsters.json `boneNodes` (the WHOLE skeleton by global id), not from the skin:
// Rathalos' body binds no vertices to tail gid 145, so that bone is missing from its skeleton's
// joints, and leaving the piece's own bone there splayed the tip across the body.
export function bonesByGidAll(root, boneNodes){
  const byName = new Map();
  root.traverse(o => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
  const map = new Map();
  for (const [name, gid, leaf] of boneNodes || []){
    const node = byName.get(name);
    if (!node) continue;
    const e = map.get(gid) || {};
    if (leaf) e.leaf = node; else e.node = node;
    map.set(gid, e);
  }
  return map;
}
export function attachPiece(pieceRoot, pieceRec, bodyRoot, bodyRec){
  const body = bonesByGidAll(bodyRoot, bodyRec && bodyRec.boneNodes);
  const missing = new Set();
  let bound = 0;
  pieceRoot.traverse(o => {
    if (!o.isSkinnedMesh) return;
    if (!o.userData.ownSkeleton) o.userData.ownSkeleton = o.skeleton;
    const src = o.userData.ownSkeleton;
    const bones = src.bones.map((bone, i) => {
      const info = (pieceRec.joints || [])[i] || {};
      const e = body.get(info.gid) || {};
      // the "_s" leaf is the bone vertices bind to and the one MT authors joint scale on
      const want = info.leaf ? (e.leaf || e.node) : (e.node || e.leaf);
      if (!want) missing.add(info.gid);
      return want || bone;
    });
    o.bind(new THREE.Skeleton(bones, src.boneInverses.map(m => m.clone())), o.bindMatrix.clone());
    o.frustumCulled = false;          // its bounds are the piece's own bind pose, not where it now draws
    bound++;
  });
  pieceRoot.position.set(0, 0, 0);
  pieceRoot.quaternion.set(0, 0, 0, 1);
  pieceRoot.scale.set(1, 1, 1);
  pieceRoot.userData.attached = true;
  return { bound, missing: [...missing] };
}
// back to the piece's own skeleton -- the prop the Debug panel fans out once the part is cut off
export function detachPiece(pieceRoot){
  pieceRoot.traverse(o => {
    if (o.isSkinnedMesh && o.userData.ownSkeleton) o.bind(o.userData.ownSkeleton, o.bindMatrix.clone());
  });
  pieceRoot.userData.attached = false;
}
// The bit of +0x8b6 that sheds a piece: the sever row (condition 1) among its own group's rows. A
// piece no row names (Nibelsnarf's) has none and stays attached.
export function pieceCutBit(rows, group){
  for (const [, g, cond, , param] of rows || [])
    if (g === group && cond === 1) return param & 0xffff;
  return 0;
}

// the status block the controls describe, for partDrawnRom
export function partStatus(controls, values, code){
  const st = { eyes: 0, cut: 0, state3: 0, variant: 0, breaks: {}, bits795: 0, flag954: 0, bitsafd: 0,
               cls: {}, inputs: {}, code: code || null };
  for (const c of controls || []){
    const v = (values && values[c.key] !== undefined) ? values[c.key] : c.value;
    if (c.key === 'eyes') st.eyes = v;
    else if (c.key.startsWith('cut')){ if (v) st.cut |= c.bit; }
    else if (c.key === 'state3') st.state3 = v;
    else if (c.key === 'variant') st.variant = v;
    else if (c.key.startsWith('break')) st.breaks[c.record] = v;
    else if (c.key.startsWith('b795_')){ if (v) st.bits795 |= c.mask; }
    else if (c.key === 'f954') st.flag954 = v;
    else if (c.key.startsWith('bafd_')){ if (v) st.bitsafd |= c.mask; }
    else if (c.input !== undefined) st.inputs[c.input] = v;
    else if (c.cond >= 100) st.cls[c.cond] = v ? 1 : 0;
  }
  return st;
}
// part -> drawn for every part a model's meshes carry. A part the class code names (partCode rows) is
// drawn from those rows alone -- the class sets it after the table every frame, and the table never
// names it; any other part from the table (a part neither names: drawn).
export function partsDrawnRom(root, table, group, st, code){
  const drawn = new Map();
  const codeRows = code ? code.rows : [];
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    const p = o.userData.part;
    if (p === undefined || drawn.has(p)) return;
    const byCode = codeRows.some(r => r[0] === p && r[1] === group);
    drawn.set(p, partDrawnRom(byCode ? codeRows : table, p, group, st));
  });
  return drawn;
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
// ---- the game's material constants -------------------------------------------------------------------
// What the 3DS texture combiners put out over the albedo map, from materials.json (mh3u_mrl.py reads the
// .mrl's constant buffers; the shader package's templates and the setup code are in notes/decode.md,
// "Material constants"):
//   nDraw::MaterialConstant (cls Constant)  colour = albedo x 0.5 * Base.rgb, alpha = albedo.a x Base.a --
//     VS_MaterialConstantObj writes 0.5 * Base as the vertex colour and one MODULATE stage takes it, so a
//     Base of 2 is the plain map and the common 1 is half of it (a ray's glow, a Rathian's eye)
//   nDraw::MaterialStd / StdNM              alpha = (bAlbedoAlpha ? albedo.a : Reflect.a) x Diffuse.a
//     (combiner stage 5 alpha, setup 0x568284), the albedo tinted by AlbedoColor (clamped to 1)
// and the alpha test the record's +0x1c word sets (GREATER ref on every monster material). The colours go
// in as sRGB: the 3DS multiplies the stored texel values, not linear light.
const ALPHA_EPS = 1 / 512;           // GREATER cuts a <= ref; three.js cuts a < alphaTest
function romConstants(mat, rom, m){
  if (!m) return;
  const blend = rom && rom.state && rom.state.blend;
  let rgb = null, a = 1, texA = true;
  if (m.cls === 'Constant' && m.base){
    rgb = [0, 1, 2].map(i => Math.min(1, 0.5 * m.base[i]));
    a = m.base[3];
  } else if (m.dif){
    a = m.dif[3];
    if (m.aa === 0){ texA = false; a *= (m.refA === undefined ? 1 : m.refA); }
    if (m.alb) rgb = [0, 1, 2].map(i => Math.min(1, m.alb[i]));
  }
  if (rgb) mat.color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  const cutting = !!(m.at && (m.at[0] === 4 || m.at[0] === 6));
  // the alpha only matters where something reads it: blending, or the alpha test
  if ((blend === 'blend' || blend === 'add' || cutting) && a !== 1) mat.opacity = a;
  // the lit path drops the map's alpha unless told to keep it (material.js uAlphaCut)
  const u = mat.userData.u;
  if (u && u.uAlphaCut) u.uAlphaCut.value = (texA && (blend === 'blend' || cutting)) ? 1 : 0;
  // an unlit overlay whose alpha is Reflect.a rather than the map's: MeshBasicMaterial always keeps the
  // map's alpha, so this one replaces it with the opacity alone
  if (!texA && mat.isMeshBasicMaterial){
    mat.onBeforeCompile = sh => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
                                                    '#include <map_fragment>\n\tdiffuseColor.a = opacity;');
    };
    mat.customProgramCacheKey = () => 'mh3u-no-map-alpha';
  }
  if (cutting){
    const cut = m.at[1] / 255 + (m.at[0] === 4 ? ALPHA_EPS : 0);
    mat.alphaTest = cut;
    mat.userData.cutout = true; mat.userData.romCut = cut;
  }
}

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
    // nDraw::MaterialConstant is unlit (one MODULATE stage of albedo and the vertex colour); Std and
    // StdNM are the lit classes
    const mat = createMaterial({ srcName, rom, alphaCut: 0, noTint: true,
                                 unlit: !!(rom && rom.cls === 'Constant'),
                                 wire: !!(ctx && ctx.wire) });
    romConstants(mat, rom, (texturesFor(ref, srcName) || {}).mat);
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
