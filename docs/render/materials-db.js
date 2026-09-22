// docs/materials.json: what the game's own material files (.mrl) say about every material,
// resolved through the shader package (build-materials.py + mfx.py). This module loads it
// once and answers lookups. Phase 2 uses only the texture bindings (which map is the albedo,
// which is the sphere map); Phase 3 drives the whole material from it.
//
// Keys: armour/Palico/char pieces by manifest key ('m001_body'), weapons by
// 'wNN/<model>' with parts as 'wNN/<model>/<sld|ya|sou_l|saya>' and kinsects as 'bug/NNN'.
// An entry is { tex: [pool paths in the MRL's texture-table order], mats: { name: {...,
// t: { albedo, spec, sphere } } } } where the t indices are 1-based into tex.
import { loadJson } from './assets.js';

let DB = null;

export async function loadMaterialsDb(){
  if (!DB) DB = await loadJson('materials.json');
  return DB;
}
export function materialsDb(){ return DB; }

export function entryFor(ref){
  if (!DB || !ref) return null;
  return (DB.weapons && DB.weapons[ref]) || (DB.pieces && DB.pieces[ref])
      || (DB.monsters && DB.monsters[ref]) || null;    // monsters: 'em/001_00', 'em/001_00/tail'
}
// the entry a shipped glb belongs to (materials.json carries the map for the weapon glbs)
export function refForGlb(glbPath){
  return (DB && DB.glb && DB.glb[glbPath]) || null;
}

// the render state of a material spec (materials.json `state` table): { bs, ds, rs, bias,
// cull, blend } with blend 'opaque' | 'alpha' | 'add' from the MRL's blend-state record
export function stateFor(m){
  return (DB && m && DB.state && m.s !== undefined) ? (DB.state[m.s] || null) : null;
}

// specFor(ref, materialName) -> everything material.js decides from: the maps, the render
// state, the feature set, the two constant blocks and the flag bits -- or null when the
// database has no entry (the exporter's Scene_Material placeholder, a hash-keyed orphan).
export function specFor(ref, name){
  const e = entryFor(ref);
  const m = e && e.mats && e.mats[name];
  if (!m) return null;
  const tex = e.tex || [];
  const pick = i => (i && tex[i - 1]) || null;
  const t = m.t || {};
  return { name, entry: e, m,
           // material animation, baked from the MRL by build-matanim.py: [{frames, loop, hash,
           // tracks:[{target, type, cb, kind, interp, keys}]}]. The target is a NAMED shader
           // constant (fUVTransform, fConstantColor, fTransparency ...) resolved through the
           // shader package, not a guessed field.
           anim: m.anim || null,
           albedo: pick(t.albedo), spec: pick(t.spec), sphere: pick(t.sphere),
           // the tNormalMap binding: monsters only (no armour or weapon ships one)
           normal: pick(t.normal),
           cls: m.cls || 'Std',
           specIsAlbedo: !!(t.spec && t.spec === t.albedo),
           state: (DB.state && DB.state[m.s]) || null, feat: (DB.feat && DB.feat[m.f]) || null,
           cbm: (DB.cbm && DB.cbm[m.c]) || null, glob: (DB.glob && DB.glob[m.g]) || null,
           flags: m.flags || 0,
           // bit 20 of the 32-bit feature word is the alpha TEST switch: it agrees with the
           // artists' XfBA / "A" suffix on 23,950 of 24,542 materials, the Palico eyes and the
           // face makeup carry it, and the 2,819 materials with the Alpha feature but without
           // it (Nerscylla's mail among them) are drawn whole in game (Raven, 2026-09-03)
           fb: parseInt(m.fb || '0', 16) >>> 0,
           alphaTest: !!(parseInt(m.fb || '0', 16) & 0x00100000),
           pigment: !!(m.flags & 0x20),                       // the dyeable region
           override: !!(m.flags & 0x40) && !(m.flags & 0x20) }; // skin / fur / face colour
}
// the database key of a shipped piece glb: models/m001_helm.glb -> m001_helm
export function refForPiece(glbPath){
  return (glbPath || '').replace(/^.*\//, '').replace(/\.glb$/i, '');
}

// texturesFor(ref, materialName) -> { albedo, mask, sphere, mat, entry } (pool paths or null)
// A material the MRL does not name (the exporter's placeholder, or a hash-keyed orphan)
// falls back to the table's first map, which is the piece's own _BM in every file seen.
export function texturesFor(ref, name){
  const e = entryFor(ref);
  if (!e) return null;
  const tex = e.tex || [];
  const pick = i => (i && tex[i - 1]) || null;
  const m = (e.mats && e.mats[name]) || null;
  if (m && m.t) return { albedo: pick(m.t.albedo), mask: pick(m.t.spec), sphere: pick(m.t.sphere), mat: m, entry: e };
  return { albedo: tex[0] || null, mask: null, sphere: null, mat: null, entry: e };
}
