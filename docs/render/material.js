// The MHGU material: MeshStandardMaterial plus the onBeforeCompile pigment / matcap shader,
// driven by what the game's own material file (.mrl) says about each material, resolved
// through the shader package into docs/materials.json (Phase 3, 2026-09-03). The shader
// text, the uniform block and the pigment math are what the single script carried, kept
// verbatim; index.html writes `tint` and calls applyTint on armorMats when a pigment changes.
//
// What the ROM decides here, per material (spec.rom, from materials-db.js specFor):
//   blend state  BSSolid opaque; BSBlendAlpha transparent, no depth write, drawn after the
//                opaque parts; BSAddAlpha additive and unlit (the glow parts); BSRevSubAlpha
//                the same but reverse-subtracted, so it DARKENS instead (monsters only:
//                Khezu's blood, Old Fatalis' face_sub, Grimclaw Tigrex's angry_arm)
//   cull         RSMesh back -> front faces only; RSMeshCN -> both; RSMeshCF -> back faces
//   depth bias   RSMeshBiasN (-32 N) -> a constant polygon offset of that many depth units
//                toward the camera, no slope term (decal layers such as the Charge Blade 064
//                shield face and the Lecturer's Footwear cuff band). A slope-scaled offset
//                pushed the cuff band through the boot shell at grazing angles (Raven,
//                2026-09-03: "a little bit of the black material ... peek out"); the constant
//                offset at the ROM's value shows none.
//   alpha        the alpha TEST is bit 20 of the material's feature word (with FTransparency
//                Alpha): discard texels at or below fAlphaClipThreshold, 0.0 on every material
//                seen, so only the exact-zero holes go. The Alpha feature without that bit
//                (Nerscylla's mail, 2,819 materials) only feeds alpha to a blend state -- the
//                game draws them whole. AlphaConstant -> the constant transparency
//   albedo tint  fAlbedoColor x fDiffuseColor multiplies the map (greys 0.8..0.95 on some)
//   emission     fEmissionColor, as self-illumination proportional to the map
//   sphere map   FReflect SphereMap -> the tSphereMap binding, scaled by fReflectiveColor
//                (0 switches it off on 31 materials that carry the feature) and the gloss:
//                the map's alpha when tSpecularMap is the albedo, else the separate specular
//                map's luminance (a greyscale mask, alpha 1.0). GlobalCubeMap is the stage's
//                reflection, which the viewer has no stand-in for: no term
//   Fresnel      Schlick with fFresnelSchlickRGB as F0 (1.0 on 246 of 264 globals: no change)
//   pigment      flag 0x20 marks the dyeable region (the `_sym_` materials, 99% of them);
//                flag 0x40 without 0x20 is the colour-override class (skin, fur, face)
// Approximations kept from before: the studio lights, roughness .85 (lowered only where
// fShininess exceeds 16), the screen-blended matcap at envAmount.
import * as THREE from 'three';

// ---- pigment state -----------------------------------------------------------------------
// Owned here so every armour material reads one truth. The picker, the per-slot rows and the
// Deviant stepper in index.html write these and then re-apply the tint.
export const tint = {
  pigment: null,        // null = the armor's own colors, untinted
  useDefaults: false,   // apply each piece's OWN authored pigment instead of one global color
  // One pigment per equipment slot, which is how the game itself stores it:
  // cArmorColorBase is mHeadColorIndex / mTorsoColorIndex / mArmColorIndex /
  // mWaistColorIndex / mLegColorIndex -- five indices, one per piece.
  slotPigment: { helm:null, body:null, arm:null, wst:null, leg:null }
};

// MHGU dyes armor with a pigment. The _bm alpha channel is the mask: bright on the
// metal/cloth trim, dark on monster-part scales -- which matches what the game lets you
// dye. So tint by alpha rather than washing the whole piece.
// matcap strength: the slider is gone, the env contribution stays at this level
export const envAmount = 0.55;

// ---- registries --------------------------------------------------------------------------
// every material the viewer built (the wireframe toggle walks this)
export const allMats = [];
// pigment applies to ARMOUR only -- never the hunter's face or hair
export const armorMats = [];

// ---- the ROM's render states ---------------------------------------------------------------
// The rasterizer's cull mode. RSMesh culls BACK faces, so the front faces render: FrontSide.
const SIDE = { back: THREE.FrontSide, none: THREE.DoubleSide, front: THREE.BackSide };
// The game discards a <= fAlphaClipThreshold; three.js discards a < alphaTest, so the
// threshold moves up by less than one 8-bit step: exactly the zero texels go.
const ALPHA_EPS = 1 / 512;
// Raven's comparison knob: null = the ROM threshold on every cutout material, a number
// forces that threshold on all of them (0.5 was the old hunter rule)
let alphaOverride = null;
// The ROM's depth bias (RSMeshBiasN, -32 a step) is in depth-buffer units, whose real size
// depends on the projection: with this viewer's near plane a unit at the model is far larger
// than in the game, so the Shadow Shades (bias -512) drew their arms through the head once
// the camera backed off (Raven, 2026-09-03: "the part that should be hidden by the head
// model is visible"). The page re-expresses a step as a fixed push in metres each frame
// (setBiasUnitsPerStep, from the camera distance and near plane); until it does, a step is
// the raw 32 units.
const biasMats = new Set();
let biasUnitsPerStep = 32;
// DEPTH WRITE COMES FROM THE ROM'S DEPTH-STENCIL STATE, not from the blend word.
// nDraw::DepthStencilState's descriptor is the MFX record's words 6..7 copied verbatim, and
// **bit 1 of word 0 is depth write** (bit 0 is depth test, bits 2..5 the compare function, bit 6
// stencil enable). The two records almost everything uses differ in that single bit:
//     DSZTest      = 0x007fff8d
//     DSZTestWrite = 0x007fff8f
// Inferring it from the blend word instead is wrong wherever the two disagree -- counted over the
// shipped data: 443 armour/weapon material rows (291 blend + 151 add that DO write depth, plus one
// opaque that does not) and 54 monster rows. The visible consequence is that additive and alpha
// layers which are supposed to lay depth down, so later geometry sorts behind them, currently let
// everything draw through them.
// We carry the record NAME rather than the word, so the map is by name; anything unrecognised
// falls back to the old blend-derived guess rather than inventing an answer.
function romDepthWrite(st, fallback){
  const ds = st && st.ds;
  if (!ds) return fallback;
  if (ds === 'DSZTestWrite' || ds === 'DSZTestWriteStencilWrite') return true;
  if (ds === 'DSZTest' || ds === 'DSZTestStencilWrite') return false;
  return fallback;
}
// RSMeshBiasN pulls a layer toward the camera. Every path that builds a material has to apply it,
// so it lives here rather than being repeated: the additive and reverse-subtract branches returned
// before the copy that used to sit further down, which silently dropped the bias on EVERY additive
// material that carries one. Counted 2026-09-06: 72 of the monsters' 78 add/revsub materials, and
// 375 of the 970 additive armour and weapon materials -- so this is NOT monster-only and it does
// change what this app draws (m680's _add_ layers, m576_helm's bma01, o072's symadd00, and 372
// more). Those are decal layers meant to sit ON the surface; with no bias they z-fight it.
// Raven, 2026-09-06, on Savage Deviljho's groups 0/3/12/100: "we need to be better able to render
// these", and "we don't 'decide' how, we let the ROM tell us how the game does it" -- the ROM says
// bias -512 on that group's XfB__m02_body_k, so it gets bias -512.
// THE OVERLAY SHADE -- what the additive and reverse-subtract branches were dropping.
// Both branches build a MeshBasicMaterial and returned before the lit path's colour work, so three
// ROM terms never reached them. They are applied here so the two branches cannot drift apart again;
// they already did once, which is how every additive material lost its depth bias.
//
//   1. THE ALBEDO TINT, fAlbedoColor x fDiffuseColor. The lit path (the `mat.color.setRGB` below)
//      and the unlit path both apply it; add/revsub did not. 24 monster materials and 588 armour
//      and weapon materials carry a non-unit tint here and were drawn untinted.
//
//   2. fConstantColor, where the feature word asks for it. `feat.albedo === 'MapConstant'` means
//      the albedo is the map MULTIPLIED BY fConstantColor, and that constant's base value is
//      glob.constant -- the same float4 the material animation's fConstantColor track writes
//      (monster.js applyTrack). Of the 78 add/revsub monster materials, 31 are MapConstant: four
//      carry a tinted constant (0.4/0.4/0.4, 0.4/0.86/1.0, 0.08/0.32/0.32, 0.32/0.08/0.08) and
//      **three carry alpha 0.0**, meaning INVISIBLE AT REST -- exactly what the ROM intends, since
//      their Angry_Start / Gekikou_Start clips ramp that alpha to 1. Savage Deviljho's
//      XfB__m02_body_k is one of the three: drawn at full strength it is a permanent glow instead
//      of one the rage lights up.
//
//   3. THE ALPHA TEST, for feat.transp === 'Alpha' with the material's alphaTest bit. 41 monster
//      and 642 armour/weapon add/revsub materials have it and were drawing their cut texels.
//
// NOT applied here, and deliberately: fEmissionColor. 71 monster add/revsub materials carry one,
// but MeshBasicMaterial has no emissive term and an additive pass is already purely additive, so
// there is nowhere faithful to put it without a custom shader. Left as an explicit gap.
function romOverlayShade(mat, rom){
  const ft = rom && rom.feat, cb = rom && rom.cbm, gl = rom && rom.glob;
  // fAlbedoColor x fConstantColor, where the feature word asks for the constant.
  // NOT cbm.diffuse. An earlier version multiplied by it as "the ROM's albedo tint" and that was
  // REFUTED from the shader package 2026-09-07: in AppShaderPackage.mfx, CBMaterial.fDiffuseColor
  // is referenced by the FDiffuse* family and by NOTHING ELSE -- no FAlbedo* feature reads it. The
  // artists zero it on precisely these overlay layers, so the rule painted mat.color pure black on
  // 583 of the 970 add/revsub armour and weapon materials and they stopped drawing at all.
  if (gl){
    const k = (ft && ft.albedo === 'MapConstant' && gl.constant) ? gl.constant : [1, 1, 1, 1];
    mat.color.setRGB(gl.albedo[0] * k[0], gl.albedo[1] * k[1], gl.albedo[2] * k[2]);
  }
  // THE TRANSPARENCY FEATURE, the right way round.
  // FTransparencyAlpha      = `mc.Alpha * CBMaterial.fTransparency`
  // FTransparencyAlphaConstant = `mc.Alpha` alone -- the ROM's own doc string for it is
  //   "透明度を返すだけ", "just returns the transparency"; it references NO constant buffer.
  // So fTransparency applies under 'Alpha', not under 'AlphaConstant'. The old code had it exactly
  // inverted, which drew at full strength six materials the ROM starts invisible (em027 m01_effect01
  // and m02_effect02, em057/em057_04 m03_effect, em086 m02_angry and m04_breathe).
  let a = 1;
  if (cb && ft && ft.transp === 'Alpha') a *= cb.transparency;
  if (ft && ft.albedo === 'MapConstant' && gl && gl.constant) a *= gl.constant[3];
  if (a !== 1) mat.opacity = a;
  if (ft && ft.transp === 'Alpha' && rom.alphaTest)
    mat.alphaTest = Math.max(0, gl ? gl.clip : 0) + ALPHA_EPS;
  return mat;
}
function applyRomBias(mat, st){
  if (!(st && st.bias)) return mat;
  mat.polygonOffset = true; mat.polygonOffsetFactor = 0;   // constant only: a slope term put a
  mat.userData.romBias = st.bias;                          // black sliver on the Lecturer's boots
  mat.polygonOffsetUnits = st.bias / 32 * biasUnitsPerStep;
  biasMats.add(mat);
  mat.addEventListener('dispose', () => biasMats.delete(mat));
  return mat;
}
export function setBiasUnitsPerStep(v){
  if (!(v > 0) || Math.abs(v - biasUnitsPerStep) < biasUnitsPerStep * 0.05) return false;
  biasUnitsPerStep = v;
  for (const m of biasMats) m.polygonOffsetUnits = m.userData.romBias / 32 * v;
  return true;
}
export function setAlphaOverride(v){
  alphaOverride = (v === null || v === undefined || v === '') ? null : +v;
  for (const m of allMats) if (m.userData.cutout) m.alphaTest = alphaOverride === null ? m.userData.romCut : alphaOverride;
  return alphaOverride;
}

export function applyTint(mat){
  // Own the uniform OBJECTS up front and hand the same ones to onBeforeCompile, so
  // changing pigment or sheen is just a .value write -- no recompile.
  if (!mat.userData.u){
    mat.userData.u = {
      uTint: { value: new THREE.Color(1,1,1) },
      uAmt:  { value: 0 },
      uEnv:  { value: null },
      uEnvAmt: { value: 0 },
      uDbg: { value: 0 },
      // fSpecularColor ($Globals float3 @44) has no MeshStandardMaterial slot; the ROM's
      // specular feeds the same reflection path this shader drives, so its luminance scales the
      // gloss. 1.0 leaves the shipped behaviour untouched until a track writes it.
      uSpecTint: { value: 1.0 },
      // fSpecularColor, $Globals float3 @44 -- the specular lobe's colour/intensity
      uSpecRGB: { value: new THREE.Vector3(1, 1, 1) },
      uKey: { value: new THREE.Color(1,1,1) },          // the armor's AUTHORED color
      uHasKey: { value: 0 },
      uKeyTol: { value: 0.15 },
      uSatBoost: { value: 1.0 },   // debug: exaggerate color so neutral areas stand out
      // Cut at the VALLEY between the two populations, not inside one of them.
      // An armour texture is bimodal in saturation: the neutral (dyeable) lobe runs
      // 0..~0.45 and the coloured armour sits at 0.5+, with a clear trough between.
      // The old 0.06-0.30 window ended mid-lobe, so it selected the whitest part of a
      // dyeable band and dropped the rest -- "correct area, but not the full area".
      uSat: { value: new THREE.Vector2(0.20, 0.45) },   // saturation window
      uVal: { value: new THREE.Vector2(0.15, 0.35) },   // brightness gate
      uChar: { value: new THREE.Color(1,1,1) },  // hair / eye / skin color
      uCharAmt: { value: 0 },
      uRegion: { value: 0 },  // 1 on the material that IS the dyeable region
      // 1 where the texture's ALPHA is a real cutout and must reach alphaTest.
      //
      // This shader replaces <map_fragment> wholesale, and the replacement only ever
      // multiplied diffuseColor.RGB -- so the sampled alpha was dropped on the floor and
      // `alphaTest` compared against a diffuseColor.a that was always 1. Nothing was ever
      // discarded. It shows up on the Palico's eyes, whose quads are deliberately
      // oversized so one mesh covers every eye option: the surround is authored fully
      // transparent (92-95% of those texels sit at alpha exactly 0) and was drawing solid.
      //
      // Opt-IN: on most armour the `_bm` alpha is a GLOSS ramp, not opacity. The ROM's
      // FTransparency feature is what turns it on now (createMaterial), the name prefix
      // only where the database has no entry.
      uAlphaCut: { value: 0 },
      // the separate specular map (tSpecularMap when it is not the albedo): its luminance
      // is the gloss that scales the sphere map
      uSpec: { value: null },
      uSpecOn: { value: 0 },
      // the albedo sampled by the view-space normal (uvAlbedoMap UVViewNormal, the glow
      // materials) instead of the mesh's UVs
      uViewUv: { value: 0 },
      // Schlick's F0 for the sphere map (fFresnelSchlickRGB)
      // fFresnelSchlickRGB is a float3 in $Globals (floatOffset 41), and FFresnel has a
      // per-channel variant: 9 monster materials are FresnelSchlickRGB with a genuinely
      // non-uniform F0. Averaging them to a scalar threw that away, so this is a vec3.
      uF0: { value: new THREE.Vector3(1, 1, 1) },
      // 0..1: how far the dye region (and the material's glow) is pulled toward black.
      // The Esurient animation drives it (setRegionDark); nothing else touches it.
      uDark: { value: 0 }
    };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, mat.userData.u);
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {',
                 'uniform vec3 uTint; uniform float uAmt;' +
                 ' uniform sampler2D uEnv; uniform float uEnvAmt; uniform float uDbg;' +
                 ' uniform vec2 uSat; uniform vec2 uVal;' +
                 ' uniform vec3 uKey; uniform float uHasKey; uniform float uKeyTol;' +
                 ' uniform float uSatBoost;' +
                 ' uniform vec3 uChar; uniform float uCharAmt; uniform float uRegion;' +
                 ' uniform float uAlphaCut;' +
                 ' uniform sampler2D uSpec; uniform float uSpecOn; uniform float uViewUv; uniform vec3 uF0;' +
                 ' uniform float uSpecTint; uniform vec3 uSpecRGB;' +
                 ' uniform float uDark;' +
                 ' float gGloss = 0.0; vec3 gBase = vec3( 1.0 );' +
                 ' vec3 mhguSrgbOetf( vec3 c ){ c = max( c, vec3( 0.0 ) ); return mix( pow( c, vec3( 1.0 / 2.4 ) ) * 1.055 - 0.055, c * 12.92, vec3( lessThanEqual( c, vec3( 0.0031308 ) ) ) ); }' +
                 ' vec3 mhguSrgbEotf( vec3 c ){ c = max( c, vec3( 0.0 ) ); return mix( pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), c / 12.92, vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) ); }' +
                 ' void main() {')
        // THE SPECULAR MAP HAD NO EFFECT ON 396 OF THE 469 MATERIALS THAT BIND ONE.
        // Every monster material selects FSpecularMap (none selects FSpecularDisable), so the game
        // runs a specular term on all of them. Here gGloss was computed in map_fragment and then
        // used ONLY inside `if ( uEnvAmt > 0.0 )`, which needs a sphere map -- so on the 349 lit
        // materials without one it was discarded, and the 47 additive ones never even received the
        // texture. A specular MAP is a mask on the specular lobe, so that is where it goes: the
        // direct and indirect specular are scaled by it, which is the term the ROM is masking.
        // fSpecularColor ($Globals float3 @44) scales the same lobe and was read by no code at all;
        // 459 of 570 materials ship a non-unit value and 84 ship exactly zero -- those are matte in
        // the ROM and were shiny here.
        .replace('#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           {
             float specMask = ( uSpecOn > 0.5 || gGloss > 0.0 ) ? gGloss : 1.0;
             reflectedLight.directSpecular   *= uSpecRGB * specMask;
             reflectedLight.indirectSpecular *= uSpecRGB * specMask;
           }`)
        .replace('#include <map_fragment>',
          `#ifdef USE_MAP
             vec2 mapUv = vMapUv;
             if ( uViewUv > 0.5 ) { vec3 vnm = normalize( vNormal ); mapUv = vnm.xy * 0.5 + 0.5; }
             vec4 texel = texture2D( map, mapUv );
             // the gloss that scales the sphere map: the map's own alpha, or the separate
             // specular map's luminance where the material binds one
             gGloss = uSpecOn > 0.5 ? dot( texture2D( uSpec, vMapUv ).rgb, vec3( 0.299, 0.587, 0.114 ) ) : texel.a;
             gGloss *= uSpecTint;
             // MHGU authors the dyeable part of a texture as DESATURATED white/grey so a
             // pigment can be multiplied into it -- undyed, those areas read as the white
             // sashes and boots you see. So the mask is low saturation, not the alpha:
             // colorful areas (monster hide, painted trim) keep their own color, and
             // near-black is skipped so shadowed cloth does not light up.
             float mxC = max( texel.r, max( texel.g, texel.b ) );
             float mnC = min( texel.r, min( texel.g, texel.b ) );
             float sat = mxC > 0.0 ? ( mxC - mnC ) / mxC : 0.0;
             // THE REGION IS THE MATERIAL. Rendering the Yukumo kasa with one hue per
             // material shows the _sym_ material is exactly the band that dyes -- the
             // texel heuristics were approximating a shape the model already states
             // outright, which is why they always caught "the right area but not all of
             // it". uRegion is 1 only on that material (the ROM's flag 0x20 now).
             //
             // The saturation window is kept as a fallback for the handful of pieces
             // whose dye area is not a separate material.
             float dye = uRegion > 0.5 ? 1.0
                       : ( 1.0 - smoothstep( uSat.x, uSat.y, sat ) )
                         * smoothstep( uVal.x, uVal.y, mxC ) * 0.0;
             float luma = dot( texel.rgb, vec3(0.299, 0.587, 0.114) );
             if ( uDbg > 0.5 ) {
               // magenta = what the mask selects, greyscale = left alone
               diffuseColor.rgb *= mix( vec3(luma * 0.55), vec3(1.0, 0.0, 0.85), dye );
             } else {
               // A plain multiply can only DARKEN, so a dark piece barely moves when
               // dyed -- Astalos reads as unchanged -- while in game it visibly takes the
               // colour. Recolour by luminance instead, the same treatment the hair and
               // skin tints use, so the pigment's hue survives on dark armour while the
               // weave and shading still come through the luma term.
               vec3 dyed = uTint * ( 0.30 + luma * 1.35 );
               vec3 base = mix( texel.rgb, dyed, uAmt * dye );
               // Debug: push saturation so COLOURED areas go vivid and the neutral
               // (dyeable) ones stay grey -- greying the rest out, as the mask view does,
               // makes those two indistinguishable.
               base = clamp( vec3(luma) + ( base - vec3(luma) ) * uSatBoost, 0.0, 1.0 );
             // Hair / eye / skin color. Recolor by LUMINANCE rather than multiplying:
             // a multiply can only ever darken, so a dark brown hair texture could never
             // reach blonde. Scaling the chosen color by luma (x2, so mid-grey lands on
             // the color itself) keeps the strand and shading detail while actually
             // changing the hue.
             if ( uCharAmt > 0.0 ) {
               base = mix( base, uChar * luma * 2.0, uCharAmt );
             }
               gBase = base;           // the dyed albedo, for the glow below
               diffuseColor.rgb *= base;
             }
             // the region fades toward black by uDark (the Esurient animation); on a region
             // material dye is 1 everywhere, so the whole material goes with it
             diffuseColor.rgb *= 1.0 - uDark * dye;
             // hand the sampled alpha to alphaTest / blending where the map is a real cutout
             diffuseColor.a *= mix( 1.0, texel.a, uAlphaCut );
           #endif`)
        // The glow is the emission constant times the DYED albedo, not the raw map. With the
        // raw map the dye region -- authored whitish so a pigment can be multiplied in --
        // glowed grey over whatever pigment was on it and washed it out (Raven, 2026-09-04:
        // "The female Esurient armors seem to wash out the pigment"; green read as
        // (119,162,114) with the glow and (15,117,16) without). Undyed materials are
        // unchanged: gBase is then the map texel, which is what the stock chunk sampled.
        // And the glow goes to black with the region.
        .replace('#include <emissivemap_fragment>',
          `#ifdef USE_EMISSIVEMAP
             totalEmissiveRadiance *= gBase;
           #endif
           totalEmissiveRadiance *= 1.0 - uDark;`)
        // MHGU shades armor with a 64x64 spherical env map (a matcap) scaled by gloss.
        // Sample it with the view-space normal and screen it over the lit colour. The screen
        // has always run on the sRGB-ENCODED colour -- it sat after <colorspace_fragment>,
        // on the canvas -- so it runs here on an explicit encode and is decoded again: the
        // same pixels on the canvas, and right in a linear render target too, where three's
        // own <colorspace_fragment> is the identity (Raven, 2026-09-04: post-processing).
        .replace('#include <colorspace_fragment>',
          `if ( uEnvAmt > 0.0 ) {
             vec3 vn = normalize( normal );
             vec2 muv = vn.xy * 0.5 + 0.5;
             vec3 env = texture2D( uEnv, muv ).rgb;
             // gloss^2 biases the sheen toward genuinely reflective texels: ~400 pieces
             // have a near-solid gloss mask and a linear term washes them out.
             float g = gGloss * gGloss;
             // Schlick: F0 + (1 - F0)(1 - N.V)^5, with F0 = fFresnelSchlickRGB (1.0 on nearly
             // every material, which leaves the term at 1)
             vec3 fres = uF0 + ( vec3( 1.0 ) - uF0 ) * pow( 1.0 - clamp( vn.z, 0.0, 1.0 ), 5.0 );
             // SCREEN blend, not additive -- a + b*(1-a) cannot exceed 1, so bright
             // armor keeps its detail instead of clipping to white.
             vec3 enc = mhguSrgbOetf( gl_FragColor.rgb );
             enc += env * g * uEnvAmt * fres * ( 1.0 - enc );
             gl_FragColor.rgb = mhguSrgbEotf( enc );
           }
           #include <colorspace_fragment>`);
    };
    mat.needsUpdate = true;
  }
  const u = mat.userData.u;
  u.uRegion.value = mat.userData.dyeRegion ? 1 : 0;
  const own = tint.useDefaults && mat.userData.own ? mat.userData.own.rgb : null;
  const slotCol = tint.slotPigment[mat.userData.slot] || null;
  const use = own || slotCol || (tint.useDefaults ? null : tint.pigment);
  const key = mat.userData.own;                 // authored color = the region key
  u.uHasKey.value = key ? 1 : 0;
  if (key) u.uKey.value.setRGB(key.rgb[0]/255, key.rgb[1]/255, key.rgb[2]/255);
  if (use && !mat.userData.noTint){
    u.uTint.value.setRGB(use[0]/255, use[1]/255, use[2]/255);
    u.uAmt.value = 1;
  } else {
    u.uAmt.value = 0;
  }
  u.uEnvAmt.value = envStrength(mat);
}
export const setTint = applyTint;

// How far a material's dye region and glow sit toward black, 0 (its colour) to 1 (black).
// Written every frame by the Esurient animation in index.html.
export function setRegionDark(mat, k){
  const u = mat.userData.u;
  if (u) u.uDark.value = k;
}

// The sphere map's weight: nothing without a map; with the ROM's material, the reflective
// colour scales it (fReflectiveColor); without one, the old rule -- an env token in the name.
function envStrength(mat){
  const u = mat.userData.u;
  if (!u.uEnv.value) return 0;
  if (mat.userData.rom) return envAmount * (mat.userData.reflective === undefined ? 1 : mat.userData.reflective);
  return /env/i.test(mat.name || '') ? envAmount : 0;
}

// The one material every mesh gets -- armour, character parts, Palico and weapons all take
// this path. `spec`:
//   srcName    the glTF material name (kept as mat.name)
//   rom        the material's entry from materials.json (materials-db.js specFor), or null
//              for the exporter's placeholders; decides everything listed at the top
//   alphaCut   fallback alphaTest threshold when there is no rom entry (0 = no cutout)
//   noTint     never takes the armour pigment
//   tintClass  'skin' | 'hair' | 'eye' | 'fur' | 'oeye' -- takes the character colour instead
//   dyeRegion  fallback: 1 on the `_sym_` material when there is no rom entry
//   slot       the pigment row this material reads ('helm'..'leg', 'cloth', 'ohelm', 'obody')
//   own        the piece's authored default pigment ({i, hex, rgb}) or null
//   wire       the wireframe toggle's current state
//   unlit      OPT-IN: draw this material unlit (the map as the colour), honouring the ROM's
//              cull mode and blend state. The MRL's class is nDraw::MaterialConstant or
//              MaterialConstantFog on 325 hunter/weapon materials as well as the monsters'
//              eyes, but this app has always drawn those through the lit path, and switching
//              them wholesale would change armour that Raven has already reviewed. So the
//              CALLER opts in (render/monster.js does; nothing in the Armor Viewer does).
// The result carries userData.renderOrder (10 blended, 20 additive) for the mesh, and
// userData.emissiveFromMap when the caller should hand the loaded map to emissiveMap too.
export function createMaterial(spec){
  const rom = spec.rom || null;
  const st = rom && rom.state, ft = rom && rom.feat, cb = rom && rom.cbm, gl = rom && rom.glob;
  const side = (st && st.cull in SIDE) ? SIDE[st.cull] : THREE.DoubleSide;   // FrontSide is 0: no || here
  if (st && st.blend === 'add'){
    // Additive materials are the glow parts, drawn unlit and added over what is behind:
    // the Charge Blade's phial box (part 24, XfB_0__m30_gaxe064_add_) is a 12-vertex box
    // whose texel is black, so it adds nothing until its material animation lights it
    // (triggers 28/29). Lit and opaque it was the "black mass" on the drawn sword, and lit
    // with the matcap it still left a grey box (Raven, 2026-09-03). No matcap, no lights.
    // An additive material that binds NO albedo map (the Sword & Shield 134 "one134_add_"
    // binds only a sphere map) draws nothing here: the game samples an unbound albedo as
    // black, so the overlay adds nothing until a material animation lights it -- the same
    // story as the Charge Blade's phial box. Drawn unlit and mapless it was a flat white
    // shield and a white blade; the Phase 2 fallback (the table's first map, added over
    // itself) doubled the blade's brightness instead. Its sphere map is kept on userData
    // for the day the material animations are read.
    const mat = new THREE.MeshBasicMaterial({ name: spec.srcName, side, blending: THREE.AdditiveBlending,
                                              transparent: true, depthWrite: romDepthWrite(st, false),
                                              wireframe: !!spec.wire });
    if (rom && !rom.albedo){ mat.visible = false; mat.userData.maplessOverlay = true; }
    romOverlayShade(mat, rom);
    mat.userData.rom = rom; mat.userData.unlit = true; mat.userData.noTint = true;
    mat.userData.renderOrder = 20;
    return applyRomBias(mat, st);
  }
  if (st && st.blend === 'revsub'){
    // The additive path's mirror image: same source and destination factors, the opposite
    // equation. The MRL blend word says so -- 0x20802 is BSAddAlpha and 0x4020802 is
    // BSRevSubAlpha, differing only in bit 0x4000000 -- so this is dst - src*srcAlpha where
    // add is dst + src*srcAlpha: a layer that DARKENS what is behind it.
    //
    // It went unmapped in mfx.py until Raven found Khezu "covered in ... a mesh"
    // (2026-09-04). An unrecognised blend word falls through to the lit opaque path, and a
    // darkening overlay drawn opaque is a solid black shell over the animal -- Khezu's
    // m03_blood over its back and wings, Old Fatalis' m01_face_sub across its neck.
    //
    // Three materials in the ROM use it, all monsters (the third is Grimclaw Tigrex's
    // m60_angry_arm); no armour or weapon material does, so this branch is unreachable in the
    // Armor Viewer and its rendering is unchanged.
    const mat = new THREE.MeshBasicMaterial({ name: spec.srcName, side, transparent: true,
                                              depthWrite: romDepthWrite(st, false), wireframe: !!spec.wire,
                                              blending: THREE.CustomBlending,
                                              blendEquation: THREE.ReverseSubtractEquation,
                                              blendSrc: THREE.SrcAlphaFactor,
                                              blendDst: THREE.OneFactor });
    // an overlay that binds no albedo samples black, and black subtracts nothing
    if (rom && !rom.albedo){ mat.visible = false; mat.userData.maplessOverlay = true; }
    romOverlayShade(mat, rom);
    mat.userData.rom = rom; mat.userData.unlit = true; mat.userData.noTint = true;
    mat.userData.renderOrder = 20;
    return applyRomBias(mat, st);
  }
  if (spec.unlit){
    // The map IS the colour: no lights, no matcap, no pigment. The ROM's cull mode and blend
    // state still apply, so a transparent constant material still sorts and a two-sided one
    // still draws both faces -- which a hard-coded MeshBasicMaterial in the caller would lose.
    const mat = new THREE.MeshBasicMaterial({ name: spec.srcName, side, wireframe: !!spec.wire });
    if (st && st.blend === 'blend'){
      mat.transparent = true; mat.depthWrite = romDepthWrite(st, false); mat.userData.renderOrder = 10;
      if (cb) mat.opacity = cb.transparency;
    }
    if (ft && (ft.transp === 'Alpha' || ft.transp === 'AlphaConstant') && rom.alphaTest)
      mat.alphaTest = Math.max(0, gl ? gl.clip : 0) + ALPHA_EPS;
    // fConstantColor BELONGS ON THIS PATH TOO. FAlbedoMapConstant means the albedo is the map
    // multiplied by fConstantColor, and the unlit branch is where the ROM's MaterialConstant /
    // MaterialConstantFog classes land -- a monster's EYE among them. It was applied only on the
    // additive branch, so 33 monster eye materials that ship fConstantColor 1.5 rendered at
    // two-thirds of the brightness the ROM gives them.
    if (gl && cb){
      const k = (ft && ft.albedo === 'MapConstant' && gl.constant) ? gl.constant : [1, 1, 1, 1];
      mat.color.setRGB(gl.albedo[0] * cb.diffuse[0] * k[0],
                       gl.albedo[1] * cb.diffuse[1] * k[1],
                       gl.albedo[2] * cb.diffuse[2] * k[2]);
    }
    applyRomBias(mat, st);
    mat.userData.rom = rom; mat.userData.unlit = true; mat.userData.noTint = true;
    return mat;
  }
  const mat = new THREE.MeshStandardMaterial({
    roughness:.85, metalness:.0, side, name:spec.srcName, transparent:false, alphaTest: 0 });
  mat.userData.rom = rom;
  // alpha: the ROM's transparency feature, else the caller's name rule
  let cut = 0, texAlpha = false;
  if (ft){
    if (ft.transp === 'Alpha' && rom.alphaTest){ cut = Math.max(0, gl ? gl.clip : 0) + ALPHA_EPS; texAlpha = true; }
  } else if (spec.alphaCut){ cut = spec.alphaCut; texAlpha = true; }
  mat.userData.cutout = texAlpha; mat.userData.romCut = cut;
  mat.alphaTest = (texAlpha && alphaOverride !== null) ? alphaOverride : cut;
  // blend state
  if (st && st.blend === 'blend'){
    mat.transparent = true; mat.depthWrite = romDepthWrite(st, false); mat.userData.renderOrder = 10;
    if (cb) mat.opacity = cb.transparency;
    if (ft && ft.transp) texAlpha = true;
  }
  applyRomBias(mat, st);
  // albedo tint, emission, shininess
  if (gl && cb) mat.color.setRGB(gl.albedo[0] * cb.diffuse[0], gl.albedo[1] * cb.diffuse[1], gl.albedo[2] * cb.diffuse[2]);
  if (gl && (gl.emission[0] + gl.emission[1] + gl.emission[2]) > 0){
    mat.emissive.setRGB(gl.emission[0], gl.emission[1], gl.emission[2]);
    mat.userData.emissiveFromMap = true;
  }
  if (gl && gl.shininess > 16) mat.roughness = Math.min(0.85, Math.max(0.4, 0.85 - Math.log2(gl.shininess / 16) * 0.15));
  mat.userData.reflective = cb ? (cb.reflective[0] + cb.reflective[1] + cb.reflective[2]) / 3 : 1;
  // THE FRESNEL SOURCE IS CHOSEN BY THE FEATURE, and reading the wrong one neuters the term.
  // $Globals declares BOTH: fFresnelSchlick (float, floatOffset 40) and fFresnelSchlickRGB
  // (float3, floatOffset 41). FFresnel's variants pick between them:
  //   Schlick     -> the SCALAR. 460 monster materials, and on 120 of them the scalar is 0.5 while
  //                  the triple is [1,1,1]. Taking the triple gave F0 = 1, so
  //                  fres = 1 + (1-1)*(...) = 1 -- a constant, i.e. no Fresnel at all.
  //   SchlickRGB  -> the TRIPLE. 9 materials, all small monsters, and their triple is [0,0,0]
  //                  while the scalar is 1.0 -- so taking the scalar killed the term the other way.
  // Materials with no FFresnel feature (101) keep F0 = 1, which is the same no-op the ROM gets by
  // not running the term.
  mat.userData.f0 = (!gl) ? [1, 1, 1]
    : (ft && ft.fresnel === 'SchlickRGB') ? gl.fresnelSchlickRGB.slice(0, 3)
    : (ft && ft.fresnel === 'Schlick')    ? [gl.fresnel, gl.fresnel, gl.fresnel]
    : [1, 1, 1];
  mat.userData.viewUv = !!(ft && ft.uvAlbedoMap === 'UVViewNormal');
  // pigment and colour override
  mat.userData.noTint = !!spec.noTint;
  if (spec.tintClass) mat.userData.tintClass = spec.tintClass;
  mat.userData.dyeRegion = rom ? rom.pigment : !!spec.dyeRegion;
  if (spec.slot !== undefined) mat.userData.slot = spec.slot;
  mat.userData.own = (spec.own !== undefined) ? spec.own : null;
  mat.wireframe = !!spec.wire;
  applyTint(mat);
  const u = mat.userData.u;
  u.uAlphaCut.value = texAlpha ? 1 : 0;
  u.uViewUv.value = mat.userData.viewUv ? 1 : 0;
  u.uF0.value.fromArray(mat.userData.f0);
  // MOVED DOWN HERE 2026-09-07 (Monster Viewer side, on Raven's call). This was written 24 lines
  // above as `mat.userData.u.uSpecRGB...`, before applyTint() had created mat.userData.u -- so it
  // threw `Cannot read properties of undefined (reading 'uSpecRGB')` on the FIRST lit material and
  // the app did not load at all. gl.specular is non-null on 215 of 215 monster $Globals rows and
  // 279 of 279 armour ones, so nothing reached the renderer. It belongs in this block, which is
  // where every other uniform is written from the same `u`.
  // NOTE: material.js is a file this repo SYNCS from the Armor Viewer and does not own, so
  // sync-render.py --check will now report `EDITED HERE` and verify-monsters.py will exit 1 until
  // the same fix lands upstream and is pulled. SOURCE.json is deliberately NOT rewritten to hide
  // that -- a red gate telling the truth beats a green one that does not.
  if (gl && gl.specular) u.uSpecRGB.value.fromArray(gl.specular.slice(0, 3));
  return mat;
}

// the env matcap, once its texture has loaded
// THE STATIC UV TRANSFORM, cbm.uv -- decoded into materials.json and never applied until now.
// CBMaterial declares three of them (mfx: fUVTransform @float 8, fUVTransform2 @16, fUVTransform3
// @24, each `float2x4`), so the 24 floats are THREE 2x4 affine matrices laid out
//     [ a  b  0  tx ]
//     [ c  d  0  ty ]
// with identity [1,0,0,0, 0,1,0,0]. The animated fUVTransform tracks build exactly this matrix at
// runtime (0xb0ca90..0xb0caf0: sin/cos into [sx*cos, -sy*sin, 0, tx] / [sx*sin, sy*cos, 0, ty]).
//
// Only the PRIMARY matrix maps onto a three.js texture's offset/repeat. Measured over the shipped
// data, that is a small population -- 2 monster and 8 armour/weapon material instances -- because
// the bulk of the non-identity rows (8 monster, 290 armour) are in fUVTransform2, the SECOND UV set,
// which belongs to the TypeExtend two-map albedo path and has no home here yet.
// Rotation is effectively unused: of 3,058 animated UV keys in the whole library exactly ONE
// carries a non-zero angle, so `center` is left at three.js's default rather than moved to (0.5,0.5)
// to match the ROM's pivot -- that would be a change with one key's worth of evidence behind it.
export function applyRomUv(mat, t){
  const cb = mat.userData.rom && mat.userData.rom.cbm;
  const uv = cb && cb.uv;
  if (!uv || !t) return t;
  const f = Array.isArray(uv[0]) ? [].concat.apply([], uv) : uv;
  if (f.length < 8) return t;
  const a = f[0], b = f[1], tx = f[3], c = f[4], d = f[5], ty = f[7];
  if (a === 1 && b === 0 && tx === 0 && c === 0 && d === 1 && ty === 0) return t;
  t.repeat.set(a, d);
  t.offset.set(tx, ty);
  if (b || c) t.rotation = Math.atan2(c, a);   // the shear terms, where a material carries any
  t.needsUpdate = true;
  return t;
}

export function setEnvTexture(mat, t){
  if (mat.isMeshMatcapMaterial){ mat.matcap = t; mat.needsUpdate = true; return; }
  if (!mat.userData.u) return;                 // an unlit additive material takes none
  mat.userData.u.uEnv.value = t;
  mat.userData.u.uEnvAmt.value = envStrength(mat);
  mat.needsUpdate = true;
}
// the separate specular map, once loaded: its luminance is the gloss
export function setSpecTexture(mat, t){
  if (!mat.userData.u) return;
  mat.userData.u.uSpec.value = t;
  mat.userData.u.uSpecOn.value = 1;
  mat.needsUpdate = true;
}

// hair / eye / skin / fur colour: a '#rrggbb' string or a THREE.Color, or null for the
// authored map
export function setCharColor(mat, c){
  const u = mat.userData.u;
  if (!u) return;
  if (!c) { u.uCharAmt.value = 0; return; }
  u.uCharAmt.value = 1;
  u.uChar.value.set(c);
}

export function setWire(mats, on){
  mats.forEach(m => m.wireframe = on);
}

// the dye-mask debug view (magenta = selected)
export function setDebug(mats, v){
  mats.forEach(m => { if (m.userData.u) m.userData.u.uDbg.value = v; });
}

// the saturation / value window the fallback mask uses, plus the debug boost
export function setMaskWindow(mats, s0, s1, v0, kt, sb){
  mats.forEach(m => { const u = m.userData.u; if (!u) return;
    u.uSat.value.set(s0, s1); u.uVal.value.set(v0, v0 + 0.20);
    u.uKeyTol.value = kt; u.uSatBoost.value = sb; });
}

// ---- MATERIAL ANIMATION -------------------------------------------------------------------------
// MOVED HERE FROM the monster app 2026-09-07, because it is not monster-specific and the Armor
// Viewer needs it: 1,486 armour and weapon materials (370 pieces, 1,116 weapons, 5,174 tracks,
// 1,177 of them auto-play) carry an animation block in their .mrl and were drawn frozen at frame 0.
// material.js's own notes already deferred to this -- the Charge Blade phial box "adds nothing until
// its material animation lights it", and the Sword & Shield 134 mapless overlay likewise.
//
// The EVALUATOR is here; the CLIP-SELECTION POLICY stays with the caller, because that is where the
// two apps genuinely differ. The ROM's own default policy is the auto-play bit (clip+0x04 bit 1),
// which is what an armour viewer wants; the monster app layers its enraged/calm state on top.
//
// THE FRAME RATE. The evaluator's clock is `slotTime += material[+0x20] * dt`
//     00b0cf24 vldr s18,[r3] / 00b0cf28 vldr s0,[sb,#0x20] / 00b0cf2c vldr s2,[sp,#0x10]
//     00b0cf30 vmla.f32 s18, s0, s2
// and the sum is compared against the clip's frame count, loaded as u32 and converted
//     00b0cf38 ldr r0,[r5] / 00b0cf3c vmov s0,r0 / 00b0cf40 vcvt.f32.u32 s0,s0
// so slotTime carries the SAME UNIT as `frames`. uBaseModel 0x88c494 passes dt through unmodified
// (`0088c4c0 vldr s16,[r4,#0x1c]`, cUnit::mDeltaTime), so material animation and MOTION share one
// tick. All of that is decoded and holds.
//
// WHAT IS NOT DECODED IS THE WALL-CLOCK RATE, and this constant is an ASSUMPTION, not a reading.
// Corrected 2026-09-10 after Raven: "The game runs at ~30 FPS, so the effect looks fast compared to
// what we see in game." The two arguments that used to sit here for 60 do not survive:
//
//   * "8,848 of 14,538 durations are an integral frame count at 60 and not at 30" does not
//     discriminate. Any integer frame count is a whole number of frames at either rate; the test
//     only ever measured how round the resulting SECONDS looked, which is a matter of taste.
//   * The exported motion keyframes sit 0.01667 s apart, i.e. 59.99 fps, over 283,323 keys. That is
//     `lmt_to_gltf`'s own choice when it turned LMT frame indices into glTF seconds -- a
//     third-party tool's assumption, not the ROM's statement. Citing it as confirmation was
//     circular, and it was mine.
//
// The one structural argument that does hold points at 30. material[+0x20] multiplies dt, so it is
// a RATE MULTIPLIER, and a rate multiplier's neutral value is 1.0. For the sum to reach `frames`
// with a 1.0 multiplier, dt must be in FRAME UNITS -- about 1.0 per tick, not ~0.0167 seconds. Then
// a clip's duration is its frame count in GAME TICKS, and the wall-clock length is frames divided
// by the rate the game actually ticks at. MHGU ticks at ~30. Akantor's 96-frame Angry loop is then
// 3.2 s in game, and this viewer was playing it in 1.6 s -- exactly the doubling Raven reports.
//
// This also means the content may well be authored at 60, as Raven guessed ("it wouldn't shock me
// to find out everything is calculated around 60fps, but looks different due to the 3DS
// framerates") -- and it still plays at 30 ticks per second, because dt is counted in ticks.
//
// STILL UNREAD, and it is the thing that would settle this outright: material[+0x20] itself.
// Searched again 2026-09-10 and it is not written anywhere in the material-animation module
// (0xb08000..0xb12000 holds no `vstr` to [reg,#0x20]), and it does not come from the .mrl -- the
// material record is 60 bytes and words 8..12 and 14, the only ones nothing reads, are ZERO on all
// 577 monster materials across 187 files. So it is set by code that has not been found. Until it
// is, this number rests on Raven's eyes rather than on the ROM, and it is labelled that way.
//
// REVERTED TO 60 the same day, because changing it globally REGRESSED A MONSTER Raven had already
// signed off. He set 30 from Akantor's rage effect looking fast against the game; within the hour:
// "Grimclaw albedo looks wrong agian", and "Tigrex still looks fine somehow". A diff of every
// change since Grimclaw last looked right came back with exactly two, one of them an em033_00-only
// parts entry that cannot reach Grimclaw -- so this constant was the cause, with nothing else in
// the running. Tigrex survived it because he has ONE animated material; Grimclaw has four, and one
// of them cycles fEmissionColor from (0.75, 0.25, 0.25) to (1, 0, 0) on a 90-frame loop, so halving
// the rate is plainly visible on him and nearly invisible on Tigrex.
//
// THE LESSON, and it is the reason this note is long. A single global constant is the wrong
// instrument for a question the ROM has not answered. It silently re-times all 425 monster clips to
// buy one monster's effect, and the cost lands on monsters already judged -- Raven, seeing it:
// "this is the exact situation I wanted to avoid". The rate stays at the value everything was
// judged against until material[+0x20] is actually read, and anything wanting a different speed
// should be a control Raven can turn, not a constant swapped underneath him.
//
// So 60 here is NOT a claim that 60 is the ROM's rate. It is the value the library was reviewed at.
// The argument above for 30 still stands on its own terms and is deliberately left in place.
export const MAT_FPS = 60;

const animBase = new WeakMap();

function sampleTrack(tr, f){
  const k = tr.keys;
  if (!k || !k.length) return null;
  if (k.length === 1 || f <= k[0][0]) return k[0].slice(1);
  const last = k[k.length - 1];
  if (f >= last[0]) return last.slice(1);
  let i = 0;
  while (i < k.length - 1 && k[i + 1][0] <= f) i++;
  const a = k[i], b = k[i + 1];
  if (tr.interp === 0) return a.slice(1);          // hold
  // Kinds 2, 3 and 5 are STEP tracks in the ROM: their handlers go straight from the key search to
  // the writer with no interpolation (kind 3 at 0xb0be14). Interpolating kind 3 would produce a
  // fractional TEXTURE INDEX -- 4 half way between 3 and 5.
  if (tr.kind === 2 || tr.kind === 3 || tr.kind === 5) return a.slice(1);
  const span = b[0] - a[0];
  const t = span > 0 ? (f - a[0]) / span : 0;
  const n = Math.min(a.length, b.length);
  // THE CUBIC. The game dispatches on interp alone -- `cmp r3,#4 / cmpne r3,#2 / bne <linear>` at
  // 0xb0c0cc -- so 2 and 4 are cubic Hermite and everything else is linear. The tangents are NOT
  // stored; the format has nowhere to put them. They are built from the neighbouring keys in the
  // non-uniform Catmull-Rom form, using the key BEFORE the segment (P) and the one AFTER it (C):
  //     mA = 0.5 * [ (B - A) + (A - P) * dtAB/dtPA ]
  //     mB = 0.5 * [ (C - B) * dtAB/dtBC + (B - A) ]
  //     H(u) = A + mA*u + (3B - 3A - 2mA - mB)*u^2 + (2A - 2B + mA + mB)*u^3
  // At the ends the missing neighbour collapses its term to zero, leaving the half-slope of the
  // segment itself -- what the ROM gets by clamping its key search.
  // 65 monster tracks are interp 2 (fConstantColor 15, fDiffuseColor 12, fTransparency 12,
  // fEmissionColor 10, fUVTransform 8, fAlbedoColor 6, fDistortion* 2); none is interp 4.
  if ((tr.interp === 2 || tr.interp === 4) && span > 0){
    const p = k[i - 1] || a, c2 = k[i + 2] || b;
    const rPA = (a[0] - p[0]) > 0 ? span / (a[0] - p[0]) : 0;
    const rBC = (c2[0] - b[0]) > 0 ? span / (c2[0] - b[0]) : 0;
    const u2 = t * t, u3 = u2 * t;
    const out = [];
    for (let c = 1; c < n; c++){
      const A = a[c], B = b[c];
      const P = (p[c] === undefined) ? A : p[c];
      const C = (c2[c] === undefined) ? B : c2[c];
      const mA = 0.5 * ((B - A) + (A - P) * rPA);
      const mB = 0.5 * ((C - B) * rBC + (B - A));
      out.push(A + mA * t + (3 * B - 3 * A - 2 * mA - mB) * u2 + (2 * A - 2 * B + mA + mB) * u3);
    }
    return out;
  }
  const out = [];
  for (let c = 1; c < n; c++) out.push(a[c] + (b[c] - a[c]) * t);
  return out;
}

// A track WRITES its shader constant; it does not scale the shipped one. That distinction is not
// cosmetic: Savage Deviljho's Gekikou decal ships fTransparency 0.0 and fDiffuseColor (0,0,0) --
// deliberately invisible until the clip runs -- so multiplying by the static value pinned it at
// zero for ever and the effect could never appear. The static values ARE the animation's frame-0
// state, which is why they look like "off".
// The lit path folds the ROM's albedo tint into material.color as glob.albedo * cbm.diffuse, so an
// animated fDiffuseColor is re-multiplied by glob.albedo rather than replacing the pair.
function baseOf(m){
  let b = animBase.get(m);
  if (!b){
    const rom = m.userData && m.userData.rom;
    const gl = rom && rom.glob;
    const u = m.userData && m.userData.u;
    const tx = m.map;
    b = { color: m.color ? m.color.clone() : null, opacity: m.opacity,
          transparent: m.transparent,
          map: m.map || null,                    // the shipped albedo, so a kind-3 swap reverses
          albedo: (gl && gl.albedo) ? gl.albedo.slice(0, 3) : [1, 1, 1],
          // EVERY OTHER DESTINATION A TRACK WRITES, snapshotted so it can be put back. Colour,
          // opacity and the map used to be the whole of it, which meant a material that STOPPED
          // being animated kept the last emission, reflection, specular and UV a clip had left on
          // it -- for ever. Khezu, 2026-09-09: leaving the charged state put Body_Taiden_End's
          // last frame on the body (fEmissionColor 0.1/0.11/0.15, fReflectiveColor 0.732 against
          // its shipped 0.165) and nothing ever took it off again. The ROM has no such state: it
          // rebuilds the constant buffer from the material's own values every frame.
          emissive:  m.emissive ? m.emissive.clone() : null,
          reflective: m.userData ? m.userData.reflective : undefined,
          envAmt:    u && u.uEnvAmt   ? u.uEnvAmt.value   : undefined,
          specTint:  u && u.uSpecTint ? u.uSpecTint.value : undefined,
          distFac:   u && u.uDistFac  ? u.uDistFac.value  : undefined,
          distBlend: u && u.uDistBlend ? u.uDistBlend.value : undefined,
          extXf:     u && u.uExtXf   ? u.uExtXf.value.clone()   : null,
          extTint:   u && u.uExtTint ? u.uExtTint.value.clone() : null,
          // ONLY WHERE THIS MATERIAL ITSELF DRIVES IT. A texture object is SHARED between
          // materials, so a material that merely happens to bind the same map must not put its own
          // offset back every frame -- that would fight whichever material is actually scrolling
          // it. Snapshot the UV only when one of this material's own clips targets fUVTransform.
          uv: (tx && (rom && rom.anim || []).some(c => (c.tracks || [])
                        .some(t => t.target === 'fUVTransform')))
              ? { offset: tx.offset.clone(), repeat: tx.repeat.clone(), rotation: tx.rotation }
              : null };
    animBase.set(m, b);
  }
  return b;
}
// Put a material back on its shipped values. Called before the running slots are applied, so every
// frame starts from a known state whatever the clip selection did last frame.
function restoreBase(m, b){
  if (b.color && m.color) m.color.copy(b.color);
  if (b.opacity !== undefined) m.opacity = b.opacity;
  if (b.emissive && m.emissive) m.emissive.copy(b.emissive);
  if (m.userData){
    if (b.reflective !== undefined) m.userData.reflective = b.reflective;
    else delete m.userData.reflective;
    const u = m.userData.u;
    if (u){
      if (u.uEnvAmt    && b.envAmt    !== undefined) u.uEnvAmt.value    = b.envAmt;
      if (u.uSpecTint  && b.specTint  !== undefined) u.uSpecTint.value  = b.specTint;
      if (u.uDistFac   && b.distFac   !== undefined) u.uDistFac.value   = b.distFac;
      if (u.uDistBlend && b.distBlend !== undefined) u.uDistBlend.value = b.distBlend;
      if (u.uExtXf   && b.extXf)   u.uExtXf.value.copy(b.extXf);
      if (u.uExtTint && b.extTint) u.uExtTint.value.copy(b.extTint);
    }
  }
  // fUVTransform drives the texture objects themselves, and a texture is SHARED between
  // materials -- so only the material that owns this base may put it back, and only to the
  // values it was built with.
  if (b.uv && m.map){
    m.map.offset.copy(b.uv.offset);
    m.map.repeat.copy(b.uv.repeat);
    m.map.rotation = b.uv.rotation;
  }
}

function applyTrack(m, tr, f){
  const v = sampleTrack(tr, f);
  if (!v) return;
  const b = baseOf(m);
  // The ROM writes only as many floats as the member word asks for. The vector writer 0xb0f844
  // stores float 0 unconditionally, then returns early on ((member>>10)&3):
  //   00b0f944  str r1,[r0,r7,lsl #2]   ; float 0 always
  //   00b0f948  ubfx r1, r2, #0xa, #2   ; cols-1
  //   00b0f950  beq #0xb0f97c           ; cols-1 == 0 -> stop after ONE
  // 380 of the 550 monster tracks carrying a member word are 3-column, so reading v[3] on them
  // applies a fourth component the game never writes.
  const cols = tr.cols || v.length;
  switch (tr.target){
    // fUVTransform2 and fUVTransform3 DO NOT drive the primary map. CBMaterial declares three
    // separate float2x4 matrices (floatOffset 8, 16, 24) and feat.uvxf is the ROM's own routing
    // table naming which one applies to each UV slot -- ["Offset","Offset2",false,"Offset3"], i.e.
    // slot 0 (UVPrimary) takes fUVTransform, slot 1 (UVSecondary) fUVTransform2, slot 3 (UVExtend)
    // fUVTransform3. 22 monster tracks are on the 2nd and 3rd, and writing them to the primary map
    // scrolled the wrong texture. Where the material carries a second-UV map (the TypeExtend blend
    // map), they drive ITS transform; otherwise there is nothing for them to move and they are
    // dropped rather than misapplied.
    case 'fUVTransform2': case 'fUVTransform3': {
      const u = m.userData.u;
      if (u && u.uExtXf) u.uExtXf.value.set(v[2] === 0 ? 1 : v[2], v[3] === 0 ? 1 : v[3], v[0], v[1]);
      break;
    }
    case 'fUVTransform': {
      // offsetU, offsetV, scaleU, scaleV, rotation
      for (const key of ['map', 'emissiveMap', 'alphaMap']){
        const tex = m[key];
        if (!tex) continue;
        tex.offset.set(v[0], v[1]);
        tex.repeat.set(v[2] === 0 ? 1 : v[2], v[3] === 0 ? 1 : v[3]);
        tex.rotation = v[4] || 0;
      }
      break;
    }
    case 'fConstantColor':                      // rgb + alpha, written not scaled
      if (m.color) m.color.setRGB(b.albedo[0] * v[0], b.albedo[1] * v[1], b.albedo[2] * v[2]);
      if (cols > 3){                            // only when the ROM writes the fourth float
        m.opacity = v[3];
        m.transparent = true;
      }
      break;
    case 'fAlbedoColor': case 'fDiffuseColor':
      if (m.color) m.color.setRGB(b.albedo[0] * v[0], b.albedo[1] * v[1], b.albedo[2] * v[2]);
      break;
    // 8 tracks on enrage clips drive this and it had no case at all, so Crimson Fatalis, both
    // Mizutsune, Grimclaw Tigrex and Ahtal-Ka lost the part of their rage that is emission.
    case 'fEmissionColor': {
      const g = v[1] === undefined ? v[0] : v[1], bl = v[2] === undefined ? v[0] : v[2];
      // THE ROM'S COLOUR CONSTANTS ARE IN THE SAME SPACE AS ITS TEXTURES, and this one is ADDED,
      // so the space is the whole difference. three.js 0.169 has colour management on: a bare
      // setRGB writes the WORKING space, Linear-sRGB, while every map here is decoded with
      // SRGBColorSpace. So a texel of 0.2 becomes ~0.033 linear and a CONSTANT of 0.2 stays 0.2 --
      // six times brighter, added flat on top of the lighting.
      //
      // Crimson Fatalis is where it shows worst. Its `Angry` clip sets fEmissionColor to a flat
      // grey 0.2, which lifted the dark ground of a red/orange lava texture to a mid grey and
      // washed the whole monster out. Raven, 2026-09-11: "Crimson Fatalis enraged effect is whited
      // out", and "I know we had it looking correct at one point" -- correct being before this case
      // existed at all, when the emission was dropped rather than added in the wrong space.
      //
      // Reading it as sRGB is not a new decode; it is treating a constant the same way the pipeline
      // already treats a texel from the same art. FEmissionConstant is genuinely a flat constant --
      // FEmissionMap is a separate variant carrying the 0x04 "uses a map" bit in its mfx record and
      // NO monster material selects it -- so the term really is added unmodulated; only its
      // magnitude was wrong.
      if (m.emissive){ m.emissive.setRGB(v[0], g, bl, THREE.SRGBColorSpace); break; }
      // AN ADDITIVE MATERIAL HAS NO .emissive -- it is a MeshBasicMaterial, and 40 of the 101
      // fEmissionColor tracks land on one, where they were silently dropped. Those are the rage
      // glows. The ROM's emission is a term ADDED to the material's output, and an additive pass is
      // already a sum, so on this path it adds into the colour the layer contributes.
      if (m.color) m.color.setRGB(b.albedo[0] + v[0], b.albedo[1] + g, b.albedo[2] + bl);
      break;
    }
    case 'fTransparency':
      m.opacity = v[0];
      m.transparent = true;
      break;
    // Kind 3, the texture switch. The key value is a 1-BASED index into the material entry's own
    // texture table -- the encoding materials-db.js already resolves with tl[idx-1] -- written
    // through the material's own writer at vtable +0x60, not the float writers. 41 monster tracks
    // use it and 40 of them target tAlbedoMap; the Fatalis line is the heavy user.
    case 'tex': {
      const idx = v[0] | 0;
      const swap = m.userData && m.userData.texSwap;
      if (swap && idx >= 1 && swap[idx - 1] && m.map !== swap[idx - 1]){
        m.map = swap[idx - 1];
        m.needsUpdate = true;
      }
      break;
    }
    // fReflectiveColor scales the sphere-map reflection. CBMaterial declares it float3 at
    // floatOffset 4, and the static value already drives envStrength() -> uEnvAmt; the ROM animates
    // it on 16 monster tracks, which had no destination until the sphere map was bound.
    case 'fReflectiveColor': {
      const u = m.userData.u;
      if (u && u.uEnvAmt){
        const avg = (v[0] + (v[1] === undefined ? v[0] : v[1]) + (v[2] === undefined ? v[0] : v[2])) / 3;
        m.userData.reflective = avg;
        if (u.uEnv && u.uEnv.value) u.uEnvAmt.value = envStrength(m);
      }
      break;
    }
    // fAlbedoBlendColor tints the SECOND albedo map of a TypeExtend material ($Globals float4 at
    // floatOffset 4). 8 tracks, all on additive materials, and all dead until the two-map albedo
    // existed. Written into the extend uniform the monster app installs.
    case 'fAlbedoBlendColor': {
      const u = m.userData.u;
      if (u && u.uExtTint) u.uExtTint.value.set(v[0], v[1], v[2], cols > 3 ? v[3] : 1);
      break;
    }
    // fSpecularColor, $Globals float3 at floatOffset 44. MeshStandardMaterial has no specular
    // colour -- the ROM's specular feeds the same reflection path this shader drives through the
    // gloss term, so the luminance scales it. 32 monster tracks.
    // fDistortionFactor / fDistortionBlend, CBDistortion. 12 tracks, all on Refract materials,
    // with no destination until the screen-space distortion existed.
    case 'fDistortionFactor': {
      const u = m.userData.u;
      if (u && u.uDistFac) u.uDistFac.value = v[0];
      break;
    }
    case 'fDistortionBlend': {
      const u = m.userData.u;
      if (u && u.uDistBlend) u.uDistBlend.value = v[0];
      break;
    }
    case 'fSpecularColor': {
      const u = m.userData.u;
      if (u && u.uSpecTint)
        u.uSpecTint.value = 0.299 * v[0] + 0.587 * (v[1] === undefined ? v[0] : v[1])
                          + 0.114 * (v[2] === undefined ? v[0] : v[2]);
      break;
    }
    default: break;                             // a target the viewer has no home for yet
  }
}

// Drive every animated material on a mounted model. tSec is wall time; nothing here touches a
// material that carries no animation block.

// Drive every animated material under `root`. `pickClip(clips, rom)` returns the index of the clip
// to play, or -1 for none; pass `AUTO_CLIP` for the ROM's own default.
export function stepMaterialAnim(root, tSec, pickClip){
  if (!root) return 0;
  let n = 0;
  root.traverse(o => {
    const m = o.material;
    if (!m || !m.userData) return;
    const rom = m.userData.rom;
    const clips = rom && rom.anim;
    if (!clips || !clips.length) return;
    // FOUR SLOTS. A material runs up to four clips at once -- the animation state is four
    // (u32 ctl, f32 time) pairs at material+0x50+i*8, and the evaluator's outer loop is
    // `i = 0..3`. RENDER.md's rider that the slots are "never contended on monsters" is refuted:
    // no material carries two AUTO-PLAY clips, but the rage state machine at 0xe37560 deliberately
    // puts findClipByName("Angry_Start") into SLOT 1 on three materials while slot 0 holds the
    // steady-state clip. So a picker may return several indices and they are evaluated in slot
    // order, later slots writing over earlier ones exactly as the ROM's loop does.
    // A SLOT MAY RUN ON ITS OWN CLOCK. The ROM zeroes a slot's time word when it puts a clip
    // there -- Khezu's enrage is `setClip(mat, 1, "Angry_Start")` then `str 0,[mat+0x5c]` at
    // 0xd1e908, +0x5c being slot 1's time -- so a transition dropped into a slot starts at frame
    // 0 while slot 0 carries on from wherever it was. A picker may therefore return `[index, t0]`
    // pairs as well as bare indices; the pair's slot is evaluated at `tSec - t0`.
    const pick = pickClip ? pickClip(clips, rom, tSec) : AUTO_CLIP(clips);
    const raw = Array.isArray(pick) ? pick : [pick];
    const list = [];
    for (const e of raw){
      const i = Array.isArray(e) ? e[0] : e;
      if (!(i >= 0)) continue;
      const t0 = Array.isArray(e) && typeof e[1] === 'number' ? e[1] : 0;
      list.push([i, tSec - t0]);
      if (list.length === 4) break;
    }
    // NOTHING SELECTED MEANS THE MATERIAL'S OWN VALUES, NOT THE LAST ONES WRITTEN.
    // This used to `return` here, BEFORE the restore below, so a material that stopped matching a
    // clip kept whatever the previous clip had written -- for ever. Raven, 2026-09-09, on turning
    // the enrage toggle off: "it should simply revert to its base form; so it feels like we are not
    // turning off the effect after it is turned on, simply pausing it instead." That is exactly
    // what the early return did. The restore is now unconditional and the return happens after it.
    // EVERY SLOT IS RE-EVALUATED FROM A KNOWN STATE each frame. The ROM rebuilds the constant
    // buffer from the material's shipped values and then applies the running slots; these writes
    // land on a three.js material and would otherwise accumulate, so the base is restored first.
    const bs = baseOf(m);
    restoreBase(m, bs);
    if (bs.map && m.map !== bs.map && !clips.some(c => (c.tracks || []).some(t => t.kind === 3))){
      m.map = bs.map; m.needsUpdate = true;
    }
    if (!list.length) return;                             // restored above; nothing to play
    for (const [ci, t] of list) stepOneSlot(m, clips[ci], t);
    n++;
  });
  return n;
}
function stepOneSlot(m, clip, tSec){
    if (!clip || !clip.frames || !clip.tracks) return;
    // Never below frame 0. A slot with its own origin can be handed a negative time -- the parts
    // harness calls the stepper with tSec 0 while a state clock is already running -- and a
    // negative frame would extrapolate off the front of the first key rather than sit on it.
    const fr = Math.max(0, tSec) * MAT_FPS;
    // Clamped to frameCount, NOT frameCount-1. Chunk 1 disassembled this path
    // (0xb0cf38..0xb0cf88): `bge` on `time >= frameCount`, then for a non-looping clip
    // `vstr s0,[r3]` stores frameCount itself. Do NOT "fix" this to frames-1 -- that is
    // uModel::Motion's LMT rule, a DIFFERENT evaluator. Tried 2026-09-07 and reverted.
    const f = clip.loop ? fr % clip.frames : Math.min(fr, clip.frames);
    for (const tr of clip.tracks) if (!tr.unsupported) applyTrack(m, tr, f);
}
// The ROM's own default: clip+0x04 bit 1 is the auto-play flag -- at load the engine walks the clip
// table and writes every bit-1 clip into the next free slot (0xb09aac `ands r7,r7,#2` /
// `strdne r8,sb,[r1,#0x50]`). Everything else waits for a setClip call from game state.
export function AUTO_CLIP(clips){ return clips.findIndex(c => c.auto); }
