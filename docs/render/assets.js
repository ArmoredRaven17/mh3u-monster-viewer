// Loader singletons and the caches every module shares. One GLTFLoader and one TextureLoader
// for the whole viewer; a texture is decoded once and handed to every material that binds it,
// and a GLB is parsed once per cache key and cloned (skeletonClone) per mount.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const loader = new GLTFLoader(), texLoader = new THREE.TextureLoader();
export const texCache = new Map(), glbCache = new Map();
// The game's own held poses, played once on an off-screen proxy (see render/pose.js). The
// proxy GLB is cached here and reused across poses.
export const poseCache = new Map();
// the weapon's own motion sets (poses/weapons/mot/), see render/weapon.js
export const weaponMotCache = new Map();

// tiled maps viewed at a glancing angle (skirts, capes) alias badly without this
let maxAnisotropy = 1;
export function initAssets(renderer){
  maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
}

// ONE STAMP PER PAGE LOAD, appended to every MODEL and TEXTURE fetch.
//
// loadJson has always cache-busted, so the manifests were fresh while the .glb and .webp they
// name were served from the browser's disk cache -- which is the worst possible split, because
// everything the app REPORTS is current while the geometry on screen is old. It cost Raven two
// separate rounds of looking at a model I had already repaired and pushed (2026-09-12: "Hard
// Refreshed and still see the weld", then "Deployed version, Crimson is back to being shifted"
// against a deploy that was byte-for-byte correct). GitHub Pages serves these with a freshness
// lifetime and the browser does not revalidate inside it, so an ETag does not save us.
//
// PER LOAD, not per request: the stamp is fixed for the life of the page, so switching monsters
// still hits the browser cache and costs nothing, and only a reload refetches. That is the point
// -- a refresh has to be able to show new data, which is the whole contract of "hard refresh and
// look again". The cost is re-downloading what a session actually touches, once per reload.
const ASSET_V = '?v=' + Date.now();
export const bust = url => (String(url).indexOf('?') >= 0 ? url : url + ASSET_V);

// `opt.linear`: a data map (a monster's normal map) that must not be read as sRGB colour;
// cached apart from the colour reading of the same file
export async function getTexture(file, opt){
  const key = (opt && opt.linear) ? file + '#linear' : file;
  if (texCache.has(key)) return texCache.get(key);
  const t = await texLoader.loadAsync(bust(file));
  t.colorSpace = (opt && opt.linear) ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.flipY = false;
  // MT Framework tiles its maps: 14% of primitives have UVs outside 0..1, up to 6x on
  // capes, long hair and skirts. three.js defaults to ClampToEdge, which smears the edge
  // texel across everything past the first tile -- it reads as the texture being
  // magnified rather than repeated.
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAnisotropy;
  texCache.set(key, t); return t;
}

// one parse per cache key; callers skeletonClone() the scene they get back
export async function loadGlb(url, cacheKey){
  let gltf = glbCache.get(cacheKey);
  if (!gltf) { gltf = await loader.loadAsync(bust(url)); glbCache.set(cacheKey, gltf); }
  return gltf;
}

// cache-bust: the dev server sends no no-cache headers and a stale manifest
// silently strips the joint table, which makes posing a no-op
export async function loadJson(url){
  return (await fetch(url + '?v=' + Date.now())).json();
}
