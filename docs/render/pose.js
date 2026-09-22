// Posing. Every piece is skinned to the SAME shared skeleton, addressed by global bone id
// (see render/skeleton.js). Two mechanisms: the static POSES table, applied by poseObject as
// local rotations, and the game's own held poses, played on an off-screen proxy by the
// PoseDriver and copied out by global id every frame.
//   0/1/2 pelvis,spine,chest   3/4 neck,head
//   5-8   clavicle>hand, the +X arm = the hunter's LEFT (Raven: the Sword & Shield's sword,
//         which the ROM mounts on gid 8, is held in the left hand in game)
//   9-12  clavicle>hand, the -X arm = the RIGHT
//   14-16 / 17-19 hip>foot, the same sides by the same x sign     20-22 back attachment
import * as THREE from 'three';
import { loader, loadGlb, poseCache, bust } from './assets.js';
import { bonesByGid, gidBonesOf, skeletonClone } from './skeleton.js';

export const POSES = {
  't-pose': {},
  'relaxed': {
    // +Z is FORWARD (the sheathed-weapon bones 20-22 sit at -Z, on the back).
    // Elbow y must swing the forearm toward +Z: NEGATIVE on the +X arm (forearm
    // extends +X), POSITIVE on the -X arm. Getting these backwards bends both arms
    // the wrong way at the elbow. (Values tuned by eye; the +X arm is the LEFT.)
    6:{z:-1.18, y:-0.06}, 7:{z:-0.10, y:-0.34},        // +X (left) shoulder drops, elbow forward
    10:{z: 1.18, y: 0.06}, 11:{z: 0.10, y: 0.34},      // -X (right) mirror
    5:{z:-0.05}, 9:{z: 0.05},                          // clavicles settle
    2:{x: 0.045}, 3:{x:-0.035},                        // chest forward, neck counters
    14:{z: 0.045}, 17:{z:-0.045},                      // stance opens slightly
    15:{x: 0.06}, 18:{x: 0.06}                         // knees soften
  }
};

// Stance looping is OFF for now, at Raven's request, so both the hunter's animation and the
// weapon's can be seen at their END state rather than restarting. Flip to true to restore.
const POSE_LOOP = false;
const POSE_PAUSE = 1.2;      // seconds held on the last frame before the pose repeats
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4(), _s3 = new THREE.Vector3();

// the static pose: local rotations from the POSES table, by global id
export function poseObject(root, joints, poseName){
  const p = POSES[poseName] || {};
  const done = new Set();
  root.traverse(o => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    o.skeleton.bones.forEach((bone, i) => {
      const info = joints && joints[i];
      if (!info || info.gid === null) return;
      // vertices bind to the "<n>:<gid>_s" LEAF; the posable node is its parent.
      // terminal joints (no _s twin) are themselves the node.
      const node = info.leaf ? bone.parent : bone;
      if (!node || done.has(node.uuid)) return;
      done.add(node.uuid);
      const r = p[info.gid];
      node.rotation.set((r&&r.x)||0, (r&&r.y)||0, (r&&r.z)||0);
    });
  });
}

export function repose(roots, poseName){
  for (const g of roots) poseObject(g, g.userData.joints, poseName);
}

// The game's own held poses, from the lobby motion lists. Rather than retarget clips onto
// every piece (each piece binds a DIFFERENT subset of the 19 joints, so node names differ
// per piece), play the clip once on an off-screen proxy and copy its bone transforms out
// by global id -- the same addressing the static poses use.
//
// One driver serves both figures. A Palico's global bone ids address different bones from
// a hunter's, so the two cannot share one joint table -- but they CAN share one mixer,
// because only one figure is ever on screen at a time. `figure` says which one the running
// pose drives, and index.html hands step() that figure's roots.
export class PoseDriver {
  constructor(opt){
    this.defaultJoints = (opt && opt.defaultJoints) || [];
    this.onError = (opt && opt.onError) || (() => {});
    // The proxy is sampled in MODEL space (it is never in the scene); the pieces live under
    // the stage's `world` group. The rebase below maps the proxy's matrices through that
    // group, so whatever transform the group carries (today: none) applies to posed bones too.
    this.frame = (opt && opt.frame) || null;
    // the static pose freshly loaded pieces land in, and repose() returns them to
    this.staticPose = 'relaxed';
    this.figure = 'hunter';
    this.mixer = null; this.proxyBones = null; this.proxyLeaves = null; this.action = null; this.anchor = null;
    this.loopTimer = null;
    this.loopMode = null;     // (entry) => 'once' | 'repeat' | null: the caller's rule, else the per-file default
    this.onFinished = null;   // called when a one-shot action reaches its end (the stance chain)
    this.ground = null;   // the Y the feet rest at, so a pose cannot sink or float
    this.bounds = null;   // the union of the WHOLE loop, so the camera is set once
    this.center = null;   // the body's own centre, averaged over the loop
    this.clock = new THREE.Clock();
  }

  // a pose is just a (file, clip) pair -- lobby poses, weapon stances and Palico poses share this
  async play(entry, opt){
    this.figure = (opt && opt.figure) || 'hunter';
    const poseJoints = (opt && opt.joints) || this.defaultJoints;
    // Both anchors were unconditional, which is right for the hunter's lobby loops (they walk
    // and turn, and the figure must stay in frame) and wrong for a clip whose travel IS the
    // motion: a monster's charge, and any flight clip, whose lowest bone would be dragged back
    // down to the rest ground every frame. The caller may switch either off; the default is the
    // behaviour every existing caller already gets.
    this.anchorXZ = !(opt && opt.anchorXZ === false);
    this.groundLock = !(opt && opt.groundLock === false);
    // Hold the clip's `reference` node -- the travel the game adds to the unit's position --
    // at the origin while letting the root bone move: the Rath-of-Meow's shell sits at the
    // unit's origin and the ride clip's root seats the cat on it (ot_2[142], 2026-09-06).
    // The pelvis anchor cancels both kinds of motion at once, which is right for a lobby pose.
    this.holdReference = !!(opt && opt.holdReference);
    this.referenceNode = null;
    let gltf = poseCache.get(entry.file);
    if (!gltf && entry.model) {
      // A monster's motion files carry nodes and animations only (harvest-monsters.py strips
      // the mesh), so the proxy is a clone of the MODEL itself and the clip binds to it by
      // node name -- the same names, from the same converter. One proxy per model, cached;
      // the clips of every list play on it.
      let proxy = poseCache.get('proxy:' + entry.model);
      if (!proxy) {
        const g = await loadGlb(entry.model, entry.model);
        proxy = { scene: skeletonClone(g.scene), userData: { bind: [] } };
        // SCALE IS PART OF THE REST POSE. It used to be left out of this snapshot, and the proxy
        // is cached per model and reused for every clip of every list -- so one clip that scaled
        // a bone left that scale on the proxy for ever, and every later clip inherited it. It was
        // invisible only because step() then threw the scale away again; the moment scale is
        // carried, the leak is real.
        proxy.scene.traverse(o => {
          if (o.isBone || o.isObject3D)
            proxy.userData.bind.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
        });
        poseCache.set('proxy:' + entry.model, proxy);
      }
      let anim = poseCache.get('anim:' + entry.file);
      if (!anim) { anim = await loader.loadAsync(bust(entry.file)); poseCache.set('anim:' + entry.file, anim); }
      gltf = { scene: proxy.scene, animations: anim.animations, userData: proxy.userData };
    }
    if (!gltf) {
      gltf = await loader.loadAsync(entry.file);
      // Snapshot the REST pose. The proxy is cached and reused across poses, so by the
      // second pose its bones still hold wherever the previous clip left them -- measuring
      // the rest hip and ground height off that gave a correction of ~0 and every pose
      // stayed sunk through the floor.
      gltf.userData.bind = [];
      gltf.scene.traverse(o => {
        if (o.isBone || o.isObject3D)
          gltf.userData.bind.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
      });
      poseCache.set(entry.file, gltf);
    }
    for (const [node, pos, quat, scl] of gltf.userData.bind){
      node.position.copy(pos); node.quaternion.copy(quat);
      if (scl) node.scale.copy(scl);
    }
    // `entry.clip3` lets a caller hand over the clip it wants played rather than have it
    // looked up here -- the monster viewer builds a retargeted copy when a monster borrows
    // another's motion list. Nothing in this app passes it, so the lookup below is unchanged.
    const clip = entry.clip3 || THREE.AnimationClip.findByName(gltf.animations, entry.clip);
    if (!clip) { this.onError('pose clip missing: ' + entry.clip); return; }
    // the proxy is never added to the scene; it exists only to be sampled
    gltf.scene.updateMatrixWorld(true);
    this.proxyBones = new Map(bonesByGid(gltf.scene, poseJoints).map(e => [e.gid, e.node]));
    // the proxy's LEAF per gid, kept beside the drivable node purely to carry joint scale
    this.proxyLeaves = new Map(bonesByGid(gltf.scene, poseJoints)
      .filter(e => e.leaf).map(e => [e.gid, e.leaf]));
    this.referenceNode = this.holdReference ? (gltf.scene.getObjectByName('reference') || null) : null;
    this.mixer = new THREE.AnimationMixer(gltf.scene);
    // Where the pelvis sits at REST. Many of these motions carry root translation -- they
    // are lobby animations, so the character walks, steps and turns -- and left alone the
    // figure drifts out of frame. Anchoring gid 0 back to this each frame keeps the pose
    // and drops the travel.
    gltf.scene.position.set(0, 0, 0);
    gltf.scene.updateMatrixWorld(true);
    const hip = this.proxyBones.get(0);
    this.anchor = hip ? _v.setFromMatrixPosition(hip.matrixWorld).clone() : null;
    // and the height the feet rest at. These clips carry root translation in Y as well as
    // X/Z -- Motion[1] drops the hunter a full metre through the floor -- so pinning only
    // the horizontal left poses sinking below the ground with the camera aimed at where
    // they should have been. Matching the LOWEST bone rather than the pelvis keeps a crouch
    // a crouch: the hips come down, the feet stay put.
    this.ground = null;
    this.proxyBones.forEach(n => {
      n.updateWorldMatrix(true, false);
      const y = _v.setFromMatrixPosition(n.matrixWorld).y;
      if (this.ground === null || y < this.ground) this.ground = y;
    });

    this.action = this.mixer.clipAction(clip);
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    // Loop mode: the caller's rule first (index.html's Loop button, the stance chain), else
    // the per-file default. Weapon stances play once and HOLD on the last frame: looping
    // them straight through reads as a twitch -- most are under a second -- and now that
    // every clip ships rather than only the _loop ones, the one-shots snapping back
    // mid-swing is worse. The lobby poses are authored as held loops and keep looping.
    const mode = this.loopMode ? this.loopMode(entry) : null;
    const once = mode ? mode === 'once' : /poses\/weapons\//.test(entry.file || '');
    if (once) {
      this.action.setLoop(THREE.LoopOnce);
      this.action.clampWhenFinished = true;
    } else {
      this.action.setLoop(THREE.LoopRepeat);
    }
    const mine = this.mixer;                    // a pose change swaps the mixer out
    this.mixer.addEventListener('finished', () => {
      if (this.mixer !== mine) return;
      if (this.onFinished) this.onFinished();
      if (POSE_LOOP) this.loopTimer = setTimeout(() => {
        this.loopTimer = null;
        if (this.mixer === mine && this.action) this.action.reset().play();
      }, POSE_PAUSE * 1000);
    });
    this.action.reset().play();

    // Frame the ENTIRE loop, not the frame that happens to be showing. Framing at t=0 set
    // the camera from one instant of a moving animation, so anything the pose reached later
    // -- an arm thrown out, a lean, a kneel -- fell outside the shot. Walk the clip once and
    // union every bone position, with the same pelvis anchoring the live playback uses.
    this.bounds = new THREE.Box3();
    // ...and aim at the BODY, not at the centre of that union: an arm thrown overhead
    // stretches the box upward, and centring on it drops the resting figure low in frame.
    // The centre is the average, over the loop, of each FRAME's own bone-box centre --
    // feet to head. (Pelvis-to-head was the first attempt and it aims at the chest, which
    // put the body a quarter of a screen-height below centre.)
    const frameBox = new THREE.Box3(), acc = new THREE.Vector3(), fc = new THREE.Vector3();
    // Every one of the Palico's 66 guild-card poses is a single frame, so there is nothing
    // to walk -- sampling it 24 times would just measure t=0 over and over.
    const STEPS = clip.duration > 0.001 ? 24 : 1;
    let nMid = 0;
    for (let i = 0; i < STEPS; i++){
      this.mixer.setTime((i / STEPS) * clip.duration);
      this.anchorProxy();
      frameBox.makeEmpty();
      this.proxyBones.forEach(n => {
        n.updateWorldMatrix(true, false);
        _v.setFromMatrixPosition(n.matrixWorld);
        this.bounds.expandByPoint(_v);
        frameBox.expandByPoint(_v);
      });
      if (!frameBox.isEmpty()){ acc.add(frameBox.getCenter(fc)); nMid++; }
    }
    this.bounds.expandByScalar(0.12);     // bones are joints, not the silhouette
    this.center = nMid ? acc.multiplyScalar(1 / nMid) : null;
    this.mixer.setTime(0);
    this.clock.getDelta();          // drop the idle time since the clock last ran
  }

  // pin the pelvis back to its rest spot in X/Z -- these are lobby motions and many of them
  // travel, which would otherwise walk the figure out of frame
  anchorProxy(){
    const scn = this.mixer.getRoot();
    scn.position.set(0, 0, 0);
    if (this.referenceNode) this.referenceNode.position.set(0, 0, 0);
    scn.updateMatrixWorld(true);
    const hip = this.proxyBones.get(0);
    let lowest = null;
    this.proxyBones.forEach(n => {
      n.updateWorldMatrix(true, false);
      const y = _v.setFromMatrixPosition(n.matrixWorld).y;
      if (lowest === null || y < lowest) lowest = y;
    });
    let dx = 0, dz = 0;
    if (hip && this.anchor && this.anchorXZ !== false){
      _v.setFromMatrixPosition(hip.matrixWorld);
      dx = this.anchor.x - _v.x;
      dz = this.anchor.z - _v.z;
    }
    const dy = (this.groundLock !== false && this.ground !== null && lowest !== null) ? this.ground - lowest : 0;
    scn.position.set(dx, dy, dz);
    scn.updateMatrixWorld(true);
  }

  stop(){
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    if (this.action) this.action.stop();
    this.mixer = null; this.proxyBones = null; this.action = null; this.anchor = null;
    this.bounds = null; this.center = null; this.ground = null; this.referenceNode = null;
  }

  // called every frame while a game pose is playing; `roots` are the mounted pieces of the
  // figure this pose drives
  step(roots){
    if (!this.mixer || !this.proxyBones) return;
    // The clock keeps running while the tab is hidden or the loop stalls; fed raw, that
    // first delta back can exceed a one-shot's length and finish it on the spot (Play from
    // the last frame did exactly that in the harness). A tenth of a second is the most one
    // frame is allowed to advance, the same clamp the weapon's own motion uses.
    this.mixer.update(Math.min(this.clock.getDelta(), 0.1));
    this.anchorProxy();

    // WORLD matrices, for every piece -- armour included. Copying LOCAL transforms only
    // works when a piece carries the whole bone chain, and ONLY the body does: the helm
    // binds 2,3,4,20,21 and the arms 2,5..12, with no pelvis or spine above them. Given
    // local copies those pieces keep their missing ancestors at bind, so the helm hangs
    // where the head would be in T-pose while the body bends away underneath -- which is
    // the "flying off, arms in wrong places" symptom.
    if (this.frame) this.frame.updateWorldMatrix(true, false);
    for (const root of roots){
      for (const { gid, node, leaf } of gidBonesOf(root)){
        const src = this.proxyBones.get(gid);
        if (!src || !node.parent) continue;
        node.parent.updateWorldMatrix(true, false);
        _m.copy(node.parent.matrixWorld).invert();
        if (this.frame) _m.multiply(this.frame.matrixWorld);
        _m.multiply(src.matrixWorld);
        // SCALE IS KEPT. It used to go into a scratch vector and be dropped, which silently threw
        // away every joint scale the game authors -- and MT hides geometry by scaling a joint to
        // ZERO and grows it by scaling up, so this was not a rounding detail: it is the mechanism
        // behind Tetsucabra's tail swelling over its spikes, and behind the 1,112 scale tracks in
        // Fatalis's motion (values 0.0 .. 14.72, negatives included). The decompose is taken
        // against the DISPLAYED parent, whose own scale this same line has already applied, so the
        // factor that comes out is this joint's own and does not double up down the chain.
        _m.decompose(node.position, node.quaternion, _s3);
        node.scale.copy(_s3);
        // ...and the leaf the vertices actually bind to. MT authors a joint's scale on the "_s"
        // twin, which nothing drives -- the pose drives its PARENT -- so a scale written there
        // never reached the mesh at all. Copied as a LOCAL transform, not resolved through the
        // world matrix, because the leaf has no motion of its own to compose with.
        const sl = leaf && this.proxyLeaves.get(gid);
        if (sl) leaf.scale.copy(sl.scale);
      }
    }
  }

  // the static pose, against this driver's current staticPose
  poseObject(root, joints){ poseObject(root, joints, this.staticPose); }
  repose(roots){ repose(roots, this.staticPose); }
}
