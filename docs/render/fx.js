// Post-processing (Raven, 2026-09-04: "Let's plan more advance effects, lens types, locking
// focus on the hunter"): an EffectComposer over the transparent canvas, switched in only
// when an effect is on, so "effects off" is the plain renderer.render the app always had.
//
// The alpha contract, which every pass here keeps: the scene target is premultiplied RGBA in
// linear light (three's NormalBlending over a (0,0,0,0) clear premultiplies by itself); the
// last pass writes premultiplied RGBA to the canvas, which is what a premultiplied canvas
// composites and what toDataURL un-premultiplies into the cut-out PNG the Screenshot button
// promises. A full-frame effect writes ALPHA where it adds something (a glow's spill, a
// vignette's darkness), so it shows over the CSS backdrop in the view, survives as soft
// alpha in a screenshot, and lands over the painted backdrop in a clip. Under a chroma
// backdrop the feed sets `mask`, and those contributions are confined to the figure's own
// pixels so the key stays clean. Non-linear steps (tone map, encode, contrast) un-premultiply
// first: encode(c * a) is not encode(c) * a, and the blended silhouette would brighten.
//
// Every pass material is NoBlending: a ShaderMaterial blends by default, and blending a
// premultiplied edge onto whatever the target last held is exactly the smear this exists to
// avoid. The renderer's tone mapping stays NoToneMapping (three compiles linear output into
// any render target regardless); the grade pass is the one place that tone-maps and encodes.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { composerSizeFor, fovSrcOf } from './lens.js';

const VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`;

// the sRGB transfer, written out so no pass depends on which helpers three's prefix carries
const COMMON = /* glsl */`
float mhguLuma( vec3 c ){ return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
vec3 mhguOetf( vec3 c ){
  c = max( c, vec3( 0.0 ) );
  return mix( pow( c, vec3( 1.0 / 2.4 ) ) * 1.055 - 0.055, c * 12.92, vec3( lessThanEqual( c, vec3( 0.0031308 ) ) ) );
}`;

function quiet(mat){ mat.blending = THREE.NoBlending; mat.depthTest = false; mat.depthWrite = false; mat.transparent = false; return mat; }
function quietPass(pass){ quiet(pass.material); return pass; }

// ---- bloom: highpass, three blurred levels at 1/2, 1/4 and 1/8, added back with the spill
// writing alpha into the empty pixels it reaches
const HighpassShader = {
  uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.8 } },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
uniform sampler2D tDiffuse; uniform float uThreshold; varying vec2 vUv;
void main(){
  vec4 c = texture2D( tDiffuse, vUv );
  float k = smoothstep( uThreshold - 0.1, uThreshold + 0.1, mhguLuma( c.rgb ) );
  gl_FragColor = c * k;
}`
};
const BlurShader = {
  uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;
void main(){
  vec4 s = texture2D( tDiffuse, vUv ) * 0.227027;
  s += ( texture2D( tDiffuse, vUv + uDir ) + texture2D( tDiffuse, vUv - uDir ) ) * 0.1945946;
  s += ( texture2D( tDiffuse, vUv + uDir * 2.0 ) + texture2D( tDiffuse, vUv - uDir * 2.0 ) ) * 0.1216216;
  s += ( texture2D( tDiffuse, vUv + uDir * 3.0 ) + texture2D( tDiffuse, vUv - uDir * 3.0 ) ) * 0.054054;
  s += ( texture2D( tDiffuse, vUv + uDir * 4.0 ) + texture2D( tDiffuse, vUv - uDir * 4.0 ) ) * 0.016216;
  gl_FragColor = s;
}`
};
const BloomCompositeShader = {
  uniforms: { tDiffuse: { value: null }, tL0: { value: null }, tL1: { value: null }, tL2: { value: null },
              uWeights: { value: new THREE.Vector3(1, 0, 0) }, uStrength: { value: 0.6 }, uMask: { value: 0 },
              uTint: { value: new THREE.Vector3(1, 1, 1) } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse, tL0, tL1, tL2; uniform vec3 uWeights, uTint; uniform float uStrength, uMask; varying vec2 vUv;
void main(){
  vec4 base = texture2D( tDiffuse, vUv );
  vec3 spill = ( texture2D( tL0, vUv ).rgb * uWeights.x + texture2D( tL1, vUv ).rgb * uWeights.y
               + texture2D( tL2, vUv ).rgb * uWeights.z ) * uStrength * uTint;
  float a = base.a;
  // the glow lights the empty pixels it reaches: alpha rises with its brightest channel, so
  // the un-premultiplied colour of a spill pixel never has to exceed 1. Masked (a chroma
  // backdrop), alpha is left alone and the spill stays inside the figure.
  if ( uMask < 0.5 ) a = min( 1.0, a + max( spill.r, max( spill.g, spill.b ) ) * ( 1.0 - a ) );
  vec3 rgb = base.rgb + spill;
  if ( uMask > 0.5 ) rgb = min( rgb, vec3( a ) );
  gl_FragColor = vec4( rgb, a );
}`
};
class BloomPass extends Pass {
  constructor(type){
    super();
    this.type = type;
    this.levels = [];
    this.hp = quiet(new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(HighpassShader.uniforms), vertexShader: VERT, fragmentShader: HighpassShader.fragmentShader }));
    this.blur = quiet(new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(BlurShader.uniforms), vertexShader: VERT, fragmentShader: BlurShader.fragmentShader }));
    this.comp = quiet(new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(BloomCompositeShader.uniforms), vertexShader: VERT, fragmentShader: BloomCompositeShader.fragmentShader }));
    this.quad = new FullScreenQuad(null);
    this.strength = 0.6; this.threshold = 0.8; this.radius = 0.5; this.mask = 0;
    this.needsSwap = true;
  }
  setSize(w, h){
    for (const l of this.levels){ l.a.dispose(); l.b.dispose(); }
    this.levels = [];
    for (let i = 0; i < 3; i++){
      const s = 2 << i, lw = Math.max(1, Math.round(w / s)), lh = Math.max(1, Math.round(h / s));
      const a = new THREE.WebGLRenderTarget(lw, lh, { type: this.type, depthBuffer: false, stencilBuffer: false });
      this.levels.push({ a, b: a.clone(), w: lw, h: lh });
    }
  }
  draw(renderer, mat, target){
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }
  render(renderer, writeBuffer, readBuffer){
    if (!this.levels.length) this.setSize(readBuffer.width, readBuffer.height);
    const auto = renderer.autoClear; renderer.autoClear = false;
    this.hp.uniforms.tDiffuse.value = readBuffer.texture; this.hp.uniforms.uThreshold.value = this.threshold;
    this.draw(renderer, this.hp, this.levels[0].a);
    let src = this.levels[0].a;
    for (let i = 0; i < this.levels.length; i++){
      const l = this.levels[i];
      this.blur.uniforms.tDiffuse.value = src.texture; this.blur.uniforms.uDir.value.set(1 / l.w, 0);
      this.draw(renderer, this.blur, l.b);
      this.blur.uniforms.tDiffuse.value = l.b.texture; this.blur.uniforms.uDir.value.set(0, 1 / l.h);
      this.draw(renderer, this.blur, l.a);
      src = l.a;
    }
    const r = this.radius, w0 = 1, w1 = r, w2 = r * r, sum = w0 + w1 + w2;
    const u = this.comp.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tL0.value = this.levels[0].a.texture; u.tL1.value = this.levels[1].a.texture; u.tL2.value = this.levels[2].a.texture;
    u.uWeights.value.set(w0 / sum, w1 / sum, w2 / sum); u.uStrength.value = this.strength; u.uMask.value = this.mask;
    this.draw(renderer, this.comp, this.renderToScreen ? null : writeBuffer);
    renderer.autoClear = auto;
  }
  dispose(){ for (const l of this.levels){ l.a.dispose(); l.b.dispose(); } this.hp.dispose(); this.blur.dispose(); this.comp.dispose(); this.quad.dispose(); }
}

// ---- depth of field (phase B): a gather over a Vogel disc scaled by the centre pixel's circle
// of confusion. A tap counts only when its own circle reaches the centre, and a tap that is
// FARTHER than the centre counts only in proportion to the centre's own blur, so an in-focus
// silhouette stays sharp against the empty background instead of eroding into it. Empty
// pixels (depth 1) are treated as fully blurred. Premultiplied RGBA is averaged, so the
// alpha of a soft silhouette spreads with its colour. The depth comes from the scene
// target's own depth texture: the alpha-tested cut-outs of hair and eyes leave exact holes.
const DofShader = {
  uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 100 }, uOrtho: { value: 0 },
              uFocus: { value: 2.5 }, uAperture: { value: 3 }, uMaxBlur: { value: 8 }, uAniso: { value: new THREE.Vector2(1, 1) },
              uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
#include <packing>
uniform sampler2D tDiffuse, tDepth; uniform float uNear, uFar, uOrtho, uFocus, uAperture, uMaxBlur; uniform vec2 uAniso, uTexel;
varying vec2 vUv;
float viewZ( vec2 uv ){
  float d = texture2D( tDepth, uv ).x;
  if ( d >= 1.0 ) return uFar;
  return uOrtho > 0.5 ? -orthographicDepthToViewZ( d, uNear, uFar ) : -perspectiveDepthToViewZ( d, uNear, uFar );
}
// the circle of confusion as a share of the largest blur: the aperture scales the depth
// difference relative to the distance, and 0.35 puts the panel's 0-10 where an aperture of 4
// softens what is a metre behind the focus and leaves a face 10 cm off it nearly sharp
float coc( float z ){ return clamp( 0.35 * uAperture * abs( z - uFocus ) / max( z, 0.05 ), 0.0, 1.0 ) * uMaxBlur; }
void main(){
  float zc = viewZ( vUv ), cc = coc( zc );
  vec4 acc = texture2D( tDiffuse, vUv ); float wsum = 1.0;
  const int N = 32; const float GA = 2.39996323;
  for ( int i = 1; i <= N; i++ ){
    float fi = float( i ), r = sqrt( fi / float( N ) ), th = fi * GA;
    vec2 off = vec2( cos( th ), sin( th ) ) * r * cc * uAniso;
    vec2 uv = vUv + off * uTexel;
    float zt = viewZ( uv ), ct = coc( zt );
    float dist = r * cc;
    float w = step( dist, ct ) * ( zt <= zc ? 1.0 : clamp( cc / max( ct, 1e-3 ), 0.0, 1.0 ) );
    acc += texture2D( tDiffuse, uv ) * w; wsum += w;
  }
  gl_FragColor = acc / wsum;
}`
};
class DofPass extends ShaderPass {
  constructor(){ super(DofShader); quiet(this.material); this.blurFrac = 0.02; }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive){
    this.material.uniforms.tDepth.value = readBuffer.depthTexture || null;
    if (!readBuffer.depthTexture) return;              // no depth to read: leave the frame alone
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

// ---- anamorphic streaks (phase C): the highpass blurred sideways only, three times at
// strides 1, 3 and 9 texels at half resolution, added back tinted, with bloom's alpha rule
class StreakPass extends Pass {
  constructor(type){
    super();
    this.type = type; this.a = null; this.b = null;
    this.hp = quiet(new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(HighpassShader.uniforms), vertexShader: VERT, fragmentShader: HighpassShader.fragmentShader }));
    this.blur = quiet(new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(BlurShader.uniforms), vertexShader: VERT, fragmentShader: BlurShader.fragmentShader }));
    this.comp = quiet(new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(BloomCompositeShader.uniforms), vertexShader: VERT, fragmentShader: BloomCompositeShader.fragmentShader }));
    this.comp.uniforms.uTint.value.set(0.55, 0.75, 1.0); this.comp.uniforms.uWeights.value.set(1, 0, 0);
    this.quad = new FullScreenQuad(null);
    this.strength = 0.6; this.threshold = 0.8; this.mask = 0;
    this.needsSwap = true;
  }
  setSize(w, h){
    if (this.a){ this.a.dispose(); this.b.dispose(); }
    this.w = Math.max(1, Math.round(w / 2)); this.h = Math.max(1, Math.round(h / 2));
    this.a = new THREE.WebGLRenderTarget(this.w, this.h, { type: this.type, depthBuffer: false, stencilBuffer: false });
    this.b = this.a.clone();
  }
  draw(renderer, mat, target){ this.quad.material = mat; renderer.setRenderTarget(target); this.quad.render(renderer); }
  render(renderer, writeBuffer, readBuffer){
    if (!this.a) this.setSize(readBuffer.width, readBuffer.height);
    const auto = renderer.autoClear; renderer.autoClear = false;
    this.hp.uniforms.tDiffuse.value = readBuffer.texture; this.hp.uniforms.uThreshold.value = this.threshold;
    this.draw(renderer, this.hp, this.a);
    let src = this.a, dst = this.b;
    for (const stride of [1, 3, 9]){
      this.blur.uniforms.tDiffuse.value = src.texture; this.blur.uniforms.uDir.value.set(stride / this.w, 0);
      this.draw(renderer, this.blur, dst);
      const t = src; src = dst; dst = t;
    }
    const u = this.comp.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.tL0.value = src.texture; u.tL1.value = src.texture; u.tL2.value = src.texture;
    u.uStrength.value = this.strength; u.uMask.value = this.mask;
    this.draw(renderer, this.comp, this.renderToScreen ? null : writeBuffer);
    renderer.autoClear = auto;
  }
  dispose(){ if (this.a){ this.a.dispose(); this.b.dispose(); } this.hp.dispose(); this.blur.dispose(); this.comp.dispose(); this.quad.dispose(); }
}

// ---- tilt-shift (phase C): a sharp band at a height, blur growing above and below it; two
// passes, across then down; no depth involved
const TiltShader = {
  uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
              uBandY: { value: 0.5 }, uBand: { value: 0.3 }, uFalloff: { value: 0.35 }, uMaxBlur: { value: 20 } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform vec2 uDir, uTexel; uniform float uBandY, uBand, uFalloff, uMaxBlur; varying vec2 vUv;
void main(){
  float t = max( abs( vUv.y - uBandY ) - uBand * 0.5, 0.0 ) / max( uFalloff, 1e-3 );
  float r = uMaxBlur * clamp( t, 0.0, 1.0 );
  if ( r < 0.5 ){ gl_FragColor = texture2D( tDiffuse, vUv ); return; }
  vec2 st = uDir * uTexel * ( r / 6.0 );
  vec4 s = texture2D( tDiffuse, vUv ) * 0.1964;
  s += ( texture2D( tDiffuse, vUv + st ) + texture2D( tDiffuse, vUv - st ) ) * 0.1747;
  s += ( texture2D( tDiffuse, vUv + st * 2.0 ) + texture2D( tDiffuse, vUv - st * 2.0 ) ) * 0.1210;
  s += ( texture2D( tDiffuse, vUv + st * 3.0 ) + texture2D( tDiffuse, vUv - st * 3.0 ) ) * 0.0656;
  s += ( texture2D( tDiffuse, vUv + st * 4.0 ) + texture2D( tDiffuse, vUv - st * 4.0 ) ) * 0.0276;
  s += ( texture2D( tDiffuse, vUv + st * 5.0 ) + texture2D( tDiffuse, vUv - st * 5.0 ) ) * 0.0090;
  s += ( texture2D( tDiffuse, vUv + st * 6.0 ) + texture2D( tDiffuse, vUv - st * 6.0 ) ) * 0.0023;
  gl_FragColor = s / 0.9968;
}`
};

// ---- present (phase C): the last pass for a fisheye or an anamorphic lens. Fisheye remaps the
// wider rectilinear source to an equidistant projection: an output pixel's distance from the
// centre is its angle off the axis, and the pixel is transparent past the source's edge.
// Anamorphic draws the rendered strip centred on the canvas with transparent bars.
const PresentShader = {
  uniforms: { tDiffuse: { value: null }, uMode: { value: 0 }, uView: { value: 2.0944 }, uSrcTan: { value: 1.7 }, uAspect: { value: 1 }, uSqueeze: { value: 1.5 } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform float uMode, uView, uSrcTan, uAspect, uSqueeze; varying vec2 vUv;
void main(){
  if ( uMode > 1.5 ){
    float y0 = ( 1.0 - 1.0 / uSqueeze ) * 0.5;
    if ( vUv.y < y0 || vUv.y > 1.0 - y0 ){ gl_FragColor = vec4( 0.0 ); return; }
    gl_FragColor = texture2D( tDiffuse, vec2( vUv.x, ( vUv.y - y0 ) * uSqueeze ) ); return;
  }
  vec2 q = ( vUv - 0.5 ) * 2.0 * vec2( uAspect, 1.0 );
  float r = length( q );
  float theta = r * uView * 0.5;
  if ( theta >= 1.55 ){ gl_FragColor = vec4( 0.0 ); return; }
  float tt = tan( theta );
  if ( tt > uSrcTan * 0.999 ){ gl_FragColor = vec4( 0.0 ); return; }
  vec2 sdir = r > 1e-5 ? q / r : vec2( 0.0 );
  vec2 sp = sdir * ( tt / uSrcTan );
  vec2 suv = vec2( sp.x / uAspect, sp.y ) * 0.5 + 0.5;
  if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ){ gl_FragColor = vec4( 0.0 ); return; }
  gl_FragColor = texture2D( tDiffuse, suv );
}`
};

// ---- lens character: chromatic aberration, vignette, grain, in that order
const LensCharacterShader = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0 }, uAberration: { value: 0 }, uGrain: { value: 0 },
              uTime: { value: 0 }, uAspect: { value: 1 }, uMask: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) } },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
uniform sampler2D tDiffuse; uniform float uVignette, uAberration, uGrain, uTime, uAspect, uMask; uniform vec2 uResolution;
varying vec2 vUv;
void main(){
  vec2 q = ( vUv - 0.5 ) * 2.0;
  vec4 c = texture2D( tDiffuse, vUv );
  if ( uAberration > 0.0 ){
    vec2 off = uAberration * 0.01 * q;
    vec4 cr = texture2D( tDiffuse, vUv + off ), cb = texture2D( tDiffuse, vUv - off );
    float a = uMask > 0.5 ? c.a : max( c.a, max( cr.a, cb.a ) );
    c = vec4( cr.r, c.g, cb.b, a );
    if ( uMask > 0.5 ) c.rgb = min( c.rgb, vec3( a ) );
  }
  // the corners are always d = 1, whatever the aspect
  float d = length( q ) / 1.41421356;
  float v = uVignette * smoothstep( 0.35, 1.0, d );
  c.rgb *= 1.0 - v;
  if ( uMask < 0.5 ) c.a += v * ( 1.0 - c.a );
  if ( uGrain > 0.0 ){
    float n = fract( sin( dot( vUv * uResolution + uTime * 61.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5;
    c.rgb = clamp( c.rgb + uGrain * 0.05 * n * c.a, vec3( 0.0 ), vec3( max( c.a, 1.0 ) ) );
  }
  gl_FragColor = c;
}`
};

// ---- grade: the encoder of the chain. Exposure and tone map in linear light, the sRGB
// transfer, then contrast and saturation on the encoded value, all un-premultiplied
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uExposure: { value: 1 }, uContrast: { value: 1 }, uSaturation: { value: 1 }, uToneMap: { value: 0 } },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
uniform sampler2D tDiffuse; uniform float uExposure, uContrast, uSaturation, uToneMap; varying vec2 vUv;
// three r169's fits, exposure folded into uExposure
vec3 RRTAndODTFit( vec3 v ){ vec3 a = v * ( v + 0.0245786 ) - 0.000090537; vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081; return a / b; }
vec3 aces( vec3 color ){
  const mat3 ACESInputMat = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
  const mat3 ACESOutputMat = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
  color = ACESInputMat * ( color / 0.6 );
  color = RRTAndODTFit( color );
  return clamp( ACESOutputMat * color, 0.0, 1.0 );
}
vec3 neutral( vec3 color ){
  const float startCompression = 0.8 - 0.04; const float desaturation = 0.15;
  float x = min( color.r, min( color.g, color.b ) );
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < startCompression ) return color;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / ( peak + d - startCompression );
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
  return mix( color, vec3( newPeak ), g );
}
void main(){
  vec4 p = texture2D( tDiffuse, vUv );
  float a = p.a;
  vec3 c = a > 1e-3 ? p.rgb / a : vec3( 0.0 );
  c = max( c, vec3( 0.0 ) ) * uExposure;
  if ( uToneMap > 2.5 ) c = neutral( c );
  else if ( uToneMap > 1.5 ) c = c / ( vec3( 1.0 ) + c );
  else if ( uToneMap > 0.5 ) c = aces( c );
  c = mhguOetf( clamp( c, 0.0, 1.0 ) );
  c = ( c - 0.5 ) * uContrast + 0.5;
  float l = mhguLuma( c );
  c = clamp( mix( vec3( l ), c, uSaturation ), 0.0, 1.0 );
  gl_FragColor = vec4( c * a, a );
}`
};

const TONE_MAPS = { none: 0, aces: 1, reinhard: 2, neutral: 3 };

// createFx(renderer, scene) -> the composer and its passes behind one small surface
export function createFx(renderer, scene){
  const hasFloat = !!renderer.extensions.get('EXT_color_buffer_float');
  const type = hasFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const size = { w: 2, h: 2, pr: 1 };
  let composer = null, depthMode = false, forced = false, state = null;
  const stat = { ms: 0 };

  const renderPass = new RenderPass(scene, new THREE.PerspectiveCamera());
  const bloom = new BloomPass(type);
  const dof = new DofPass();
  const streak = new StreakPass(type);
  const tiltH = quietPass(new ShaderPass(TiltShader)), tiltV = quietPass(new ShaderPass(TiltShader));
  tiltV.material.uniforms.uDir.value.set(0, 1);
  const lensChar = quietPass(new ShaderPass(LensCharacterShader));
  const grade = quietPass(new ShaderPass(GradeShader));
  const fxaa = quietPass(new ShaderPass(FXAAShader));
  const present = quietPass(new ShaderPass(PresentShader));
  bloom.enabled = false; dof.enabled = false; streak.enabled = false; tiltH.enabled = false; tiltV.enabled = false;
  lensChar.enabled = false; fxaa.enabled = false; present.enabled = false;
  const passes = [renderPass, dof, bloom, streak, tiltH, tiltV, lensChar, grade, fxaa, present];
  const feedState = { focus: 2.5 };
  let lensSpec = { type: 'standard' }, canvas = { w: 2, h: 2 };

  function build(){
    if (composer){ composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); }
    const pw = Math.max(1, Math.round(size.w * size.pr)), ph = Math.max(1, Math.round(size.h * size.pr));
    const rt = new THREE.WebGLRenderTarget(pw, ph, { type, samples: depthMode ? 0 : 4, depthBuffer: true, stencilBuffer: false });
    if (depthMode){ rt.depthTexture = new THREE.DepthTexture(pw, ph); rt.depthTexture.type = THREE.UnsignedIntType; }
    composer = new EffectComposer(renderer, rt);
    if (depthMode){
      // the composer clones the first target for the second, and a cloned DepthTexture keeps
      // the same Source, which three backs with ONE GL texture: the depth-of-field pass then
      // sampled the depth it was writing over (GL_INVALID_OPERATION, a blank frame). Each
      // target gets a depth texture of its own.
      const dt2 = new THREE.DepthTexture(pw, ph); dt2.type = THREE.UnsignedIntType;
      composer.renderTarget2.depthTexture = dt2;
    }
    composer.setPixelRatio(size.pr); composer.setSize(size.w, size.h);
    for (const p of passes) composer.addPass(p);
    fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
    lensChar.material.uniforms.uResolution.value.set(pw, ph);
    dof.material.uniforms.uTexel.value.set(1 / pw, 1 / ph);
    dof.material.uniforms.uMaxBlur.value = dof.blurFrac * ph;
    for (const t of [tiltH, tiltV]){ t.material.uniforms.uTexel.value.set(1 / pw, 1 / ph); t.material.uniforms.uMaxBlur.value = 0.03 * ph; }
    present.material.uniforms.uAspect.value = canvas.w / canvas.h;
  }
  build();

  const fx = {
    get active(){
      if (forced) return true;
      if (!state) return false;
      const l = state.lens, g = state.grade;
      const lensPass = lensSpec.type === 'fisheye' || lensSpec.type === 'anamorphic' || lensSpec.type === 'tiltshift';
      return !!(lensPass || state.bloom.on || (state.dof && state.dof.on) || l.vignette > 0 || l.aberration > 0 || l.grain > 0 ||
                g.exposure !== 1 || g.contrast !== 1 || g.saturation !== 1 || (TONE_MAPS[g.toneMap] || 0) !== 0);
    },
    get depth(){ return depthMode; },
    // w, h: the canvas in CSS pixels; the composer takes the lens's own size (a fisheye source
    // is oversized, an anamorphic strip is shorter) and the present pass draws to the canvas
    setSize(w, h, pr, lens){
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h)); pr = pr || 1;
      if (lens) lensSpec = lens;
      const cs = composerSizeFor(lensSpec, w, h, pr, 4096);
      if (cs.w === size.w && cs.h === size.h && pr === size.pr && canvas.w === w && canvas.h === h) return;
      canvas.w = w; canvas.h = h; size.w = cs.w; size.h = cs.h; size.pr = pr;
      build();
    },
    // the lens: which of the present, streak and tilt passes run, and their numbers
    setLens(l){
      lensSpec = l;
      const pu = present.material.uniforms;
      present.enabled = l.type === 'fisheye' || l.type === 'anamorphic';
      pu.uMode.value = l.type === 'fisheye' ? 1 : (l.type === 'anamorphic' ? 2 : 0);
      pu.uView.value = THREE.MathUtils.degToRad(l.view || 120);
      pu.uSrcTan.value = Math.tan(THREE.MathUtils.degToRad(fovSrcOf(l.view || 120)) / 2);
      pu.uSqueeze.value = l.squeeze || 1.5;
      streak.enabled = l.type === 'anamorphic';
      tiltH.enabled = tiltV.enabled = l.type === 'tiltshift';
      for (const t of [tiltH, tiltV]){ t.material.uniforms.uBandY.value = l.bandY === undefined ? 0.5 : l.bandY; t.material.uniforms.uBand.value = l.band === undefined ? 0.3 : l.band; }
    },
    // the effects object from index.html: { bloom, dof, lens, grade }
    setState(s){
      state = s;
      bloom.enabled = !!s.bloom.on; bloom.strength = s.bloom.strength; bloom.threshold = s.bloom.threshold; bloom.radius = s.bloom.radius;
      streak.threshold = s.bloom.threshold;
      const l = s.lens, lu = lensChar.material.uniforms;
      lensChar.enabled = l.vignette > 0 || l.aberration > 0 || l.grain > 0;
      lu.uVignette.value = l.vignette; lu.uAberration.value = l.aberration; lu.uGrain.value = l.grain;
      const g = s.grade, gu = grade.material.uniforms;
      gu.uExposure.value = g.exposure; gu.uContrast.value = g.contrast; gu.uSaturation.value = g.saturation; gu.uToneMap.value = TONE_MAPS[g.toneMap] || 0;
      const d = s.dof || {}, du = dof.material.uniforms;
      dof.enabled = !!d.on; du.uAperture.value = d.aperture; dof.blurFrac = d.maxBlur;
      du.uMaxBlur.value = dof.blurFrac * Math.max(1, Math.round(size.h * size.pr));
      const wantDepth = !!d.on;
      if (wantDepth !== depthMode) fx.rebuildTargets({ depth: wantDepth });
    },
    // per frame: the clock (for the grain), the chroma mask and the aspect
    feed(f){
      const lu = lensChar.material.uniforms;
      lu.uTime.value = f.time || 0; lu.uMask.value = f.mask ? 1 : 0; lu.uAspect.value = f.aspect || 1;
      bloom.mask = f.mask ? 1 : 0; streak.mask = f.mask ? 1 : 0;
      const du = dof.material.uniforms;
      if (Number.isFinite(f.focus)) { du.uFocus.value = f.focus; feedState.focus = f.focus; }
      if (Number.isFinite(f.near)) du.uNear.value = f.near;
      if (Number.isFinite(f.far)) du.uFar.value = f.far;
      du.uOrtho.value = f.ortho ? 1 : 0;
      if (f.aniso) du.uAniso.value.copy(f.aniso); else du.uAniso.value.set(1, 1);
    },
    render(cam){
      renderPass.camera = cam;
      const t0 = performance.now();
      composer.render();
      stat.ms = stat.ms ? stat.ms * 0.95 + (performance.now() - t0) * 0.05 : performance.now() - t0;
    },
    rebuildTargets(opt){
      depthMode = !!(opt && opt.depth);
      fxaa.enabled = depthMode;
      build();
    },
    force(on){ forced = !!on; },
    stats(){
      return { ms: +stat.ms.toFixed(2), w: Math.round(size.w * size.pr), h: Math.round(size.h * size.pr), pixelRatio: size.pr,
               samples: depthMode ? 0 : 4, type: hasFloat ? 'half' : 'byte', depth: depthMode, forced, focus: feedState.focus,
               maxBlurPx: dof.material.uniforms.uMaxBlur.value,
               canvas: { w: canvas.w, h: canvas.h }, lens: lensSpec.type,
               passes: passes.filter(p => p.enabled).map(p => p === lensChar ? 'LensCharacter' : p === grade ? 'Grade' : p === fxaa ? 'FXAA' : p === present ? 'Present' : p === tiltH ? 'TiltH' : p === tiltV ? 'TiltV' : p.constructor.name) };
    },
    dispose(){ if (composer){ composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); } bloom.dispose(); streak.dispose(); },
    passes: { renderPass, dof, bloom, streak, tiltH, tiltV, lensChar, grade, fxaa, present }
  };
  return fx;
}
