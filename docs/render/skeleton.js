// Global-bone-id addressing. Every piece is skinned to the SAME shared skeleton, addressed by
// global bone id (node names are "<localIdx>:<globalId>", with a "<...>_s" leaf duplicate used
// as the skin joint). three.js STRIPS the colon, so bones are addressed by index parity with
// skins[0].joints instead -- that mapping is baked into the manifest as `joints`.
export { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// Bone lookup by GLOBAL id, using the same rule poseObject does: vertices bind to the
// "<n>:<gid>_s" LEAF and the posable node is its parent. Node NAMES cannot be used --
// three.js strips the colon, so "11:5" and "1:15" both become "115".
export function bonesByGid(root, joints){
  const map = new Map();
  root.traverse(o => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    o.skeleton.bones.forEach((bone, i) => {
      const info = joints && joints[i];
      if (!info || info.gid === null) return;
      const node = info.leaf ? bone.parent : bone;
      // The LEAF is carried alongside, because it is the bone the VERTICES bind to while `node`
      // is the one a pose drives. Everything that moves the skeleton works through `node`; only
      // SCALE has to reach the leaf as well, since MT authors a joint's scale on the leaf and
      // scaling the parent would drag the whole chain below it instead of just this joint's mesh.
      if (node && !map.has(info.gid)) map.set(info.gid, { node, leaf: info.leaf ? bone : null });
    });
  });
  // Sorted PARENT-FIRST. Poses are applied as world matrices expressed in each node's
  // parent space, so an ancestor must already hold its final transform before a
  // descendant is computed against it.
  const depth = n => { let d = 0; for (let p = n; p; p = p.parent) d++; return d; };
  return [...map.entries()]
    .map(([gid, e]) => ({ gid, node: e.node, leaf: e.leaf, d: depth(e.node) }))
    .sort((a, b) => a.d - b.d);
}

// a mounted root's gid table, built once and cached on the root
export function gidBonesOf(root){
  return root.userData.gidBones ||
    (root.userData.gidBones = bonesByGid(root, root.userData.joints || []));
}

// MHGU splits a model into mesh GROUPS. three.js strips the brackets, so glTF
// "Group[0]" becomes objects named Group0 / Group0_1 / Group0_2..., and the separate
// full-figure proxy layer "Group[100]" becomes Group100. Only group 0 is real content;
// every other group is the blocky stand-in and is never drawn. Read structurally at
// runtime so it holds for both genders and cannot drift from the manifest.
export function meshGroupId(o){
  for (let p = o; p; p = p.parent){
    const m = /^Group(\d+)(?:_\d+)?$/.exec(p.name || '');
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

// which player bone carries a gid, across the given roots -- the first root that binds it wins
export function playerBone(roots, gid){
  for (const root of roots)
    for (const b of gidBonesOf(root)) if (b.gid === gid) return b.node;
  return null;
}
