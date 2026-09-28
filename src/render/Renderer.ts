import * as THREE from 'three';
import type { ClayModel } from '../clay/ClayModel';
import { VERT_SCALE } from '../constants';
import type { Pt, TerrainConfig } from '../types';

const MAX_STOPS = 8;
const TILT_DEG = 50; // 預設俯角
const TILT_MIN = 2; // 幾乎貼著桌面，平視山的側面
const TILT_MAX = 89.9; // 正上方俯視，像地圖
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 2.2;
export const JAR_POS: Record<'left' | 'right', THREE.Vector3> = {
  left: new THREE.Vector3(-0.74, 0, 0.12),
  right: new THREE.Vector3(0.74, 0, 0.12),
};
const JAR_R = 0.095;
const UP = new THREE.Vector3(0, 1, 0);
const JAR_H = 0.13;

const vert = /* glsl */ `
attribute float aMask;
uniform float uVert;
varying float vH;
varying vec3 vN;
varying float vMask;
void main() {
  vH = position.y / uVert;
  vN = normal;
  vMask = aMask;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const frag = /* glsl */ `
uniform float uMaxM;
uniform int uCount;
uniform float uStopM[${MAX_STOPS}];
uniform vec3 uStopC[${MAX_STOPS}];
uniform float uMinor;
uniform float uMajor;
uniform float uHi;
uniform float uTime;
uniform vec3 uLight;
varying float vH;
varying vec3 vN;
varying float vMask;

vec3 ramp(float m) {
  vec3 c = uStopC[0];
  for (int i = 1; i < ${MAX_STOPS}; i++) {
    if (i >= uCount) break;
    float a = uStopM[i - 1];
    float b = uStopM[i];
    if (m >= a) c = mix(uStopC[i - 1], uStopC[i], clamp((m - a) / (b - a), 0.0, 1.0));
  }
  return c;
}

// 回傳 0–1：離最近的等高線多近（px = 線寬，以螢幕像素計）
float contour(float m, float stepM, float px) {
  float fw = max(fwidth(m), 1e-3);
  float f = abs(fract(m / stepM + 0.5) - 0.5) * stepM;
  return 1.0 - smoothstep(0.0, px * fw, f);
}

void main() {
  float m = vH * uMaxM;
  vec3 c = ramp(m);
  float diff = max(dot(normalize(vN), uLight), 0.0);
  c *= 0.55 + 0.6 * diff;
  if (m > uMinor * 0.5) {
    c = mix(c, c * 0.55, contour(m, uMinor, 1.0) * 0.8);
    c = mix(c, c * 0.35, contour(m, uMajor, 1.8));
  }
  float fw = max(fwidth(m), 1e-3);
  float hi = 1.0 - smoothstep(0.0, 2.6 * fw, abs(m - uHi));
  c = mix(c, vec3(0.7, 0.01, 0.015), hi); // 線性色彩：約 #d8171e
  float pulse = 0.35 + 0.3 * sin(uTime * 7.0);
  c = mix(c, vec3(1.0, 0.05, 0.08), vMask * pulse);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private scene = new THREE.Scene();
  private board: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private maskAttr: THREE.BufferAttribute;
  private jarClay: Record<'left' | 'right', THREE.Mesh> = {} as never;
  private jars: Record<'left' | 'right', THREE.Group> = {} as never;
  private seenVersion = -1;
  private raycaster = new THREE.Raycaster();
  private baseDist = 2;
  private view = { az: 0, tilt: TILT_DEG, zoom: 1 };
  private viewTarget = { az: 0, tilt: TILT_DEG, zoom: 1 };
  private lastTime = 0;

  constructor(canvas: HTMLCanvasElement, n: number, cfg: TerrainConfig) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 20);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x886644, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-1, 2, 1);
    this.scene.add(sun);

    // 地形底板
    const geo = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2); // 第 0 列在最遠處（v = 0）
    this.maskAttr = new THREE.BufferAttribute(new Float32Array(n * n), 1);
    geo.setAttribute('aMask', this.maskAttr);
    const stops = cfg.ramp.slice(0, MAX_STOPS);
    const stopM = new Array(MAX_STOPS).fill(1e9);
    const stopC = new Array(MAX_STOPS).fill(0).map(() => new THREE.Color(1, 1, 1));
    stops.forEach((s, i) => {
      stopM[i] = s.m;
      stopC[i] = new THREE.Color(s.color); // three 會自動轉成線性色彩空間
    });
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uVert: { value: VERT_SCALE },
        uMaxM: { value: cfg.maxElevation },
        uCount: { value: stops.length },
        uStopM: { value: stopM },
        uStopC: { value: stopC },
        uMinor: { value: cfg.contour.minor },
        uMajor: { value: cfg.contour.major },
        uHi: { value: cfg.contour.highlight },
        uTime: { value: 0 },
        uLight: { value: new THREE.Vector3(-0.5, 1, 0.6).normalize() },
      },
    });
    this.board = new THREE.Mesh(geo, mat);
    this.scene.add(this.board);

    // 底座與海
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(1.02, 0.04, 1.02),
      new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.9 }),
    );
    slab.position.y = -0.0205;
    this.scene.add(slab);
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(1.34, 1.34).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x4fa3e0, roughness: 0.4, transparent: true, opacity: 0.9 }),
    );
    sea.position.y = -0.03;
    this.scene.add(sea);

    // 左右兩個黏土罐
    for (const side of ['left', 'right'] as const) {
      const g = new THREE.Group();
      g.position.copy(JAR_POS[side]);
      this.jars[side] = g;
      const jar = new THREE.Mesh(
        new THREE.CylinderGeometry(JAR_R, JAR_R * 0.85, JAR_H, 40, 1, true),
        new THREE.MeshStandardMaterial({ color: 0xc0714f, roughness: 0.8, side: THREE.DoubleSide }),
      );
      jar.position.y = JAR_H / 2;
      const bottom = new THREE.Mesh(
        new THREE.CircleGeometry(JAR_R * 0.85, 40).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x8a4a33 }),
      );
      bottom.position.y = 0.002;
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(JAR_R, 0.008, 8, 48).rotateX(Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xa65a3c }),
      );
      rim.position.y = JAR_H;
      const clay = new THREE.Mesh(
        new THREE.CylinderGeometry(JAR_R * 0.92, JAR_R * 0.84, 1, 40),
        new THREE.MeshStandardMaterial({ color: 0x9ccc65, roughness: 0.7 }),
      );
      this.jarClay[side] = clay;
      g.add(jar, bottom, rim, clay);
      this.scene.add(g);
    }
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    // 讓底板與兩個黏土罐都在畫面內
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    this.baseDist = Math.max(0.62 / t, 1.0 / (t * cam.aspect));
    cam.updateProjectionMatrix();
    this.applyView();
  }

  /** 旋轉視角（度）：水平繞土盤轉、上下改變俯角。 */
  rotateBy(dAz: number, dTilt: number, immediate = false): void {
    this.viewTarget.az += dAz;
    this.viewTarget.tilt = THREE.MathUtils.clamp(this.viewTarget.tilt + dTilt, TILT_MIN, TILT_MAX);
    if (immediate) {
      // 手指拖曳時直接跟手，不要延遲
      this.view.az = this.viewTarget.az;
      this.view.tilt = this.viewTarget.tilt;
      this.applyView();
    }
  }

  zoomBy(f: number): void {
    this.viewTarget.zoom = THREE.MathUtils.clamp(this.viewTarget.zoom / f, ZOOM_MIN, ZOOM_MAX);
  }

  setTilt(deg: number): void {
    this.viewTarget.tilt = THREE.MathUtils.clamp(deg, TILT_MIN, TILT_MAX);
  }

  resetView(): void {
    // 轉最短的方向回到正面
    const az = this.view.az - Math.round(this.view.az / 360) * 360;
    this.view.az = az;
    this.viewTarget = { az: 0, tilt: TILT_DEG, zoom: 1 };
  }

  private applyView(): void {
    const { az, tilt, zoom } = this.view;
    const a = THREE.MathUtils.degToRad(tilt);
    const b = THREE.MathUtils.degToRad(az);
    const d = this.baseDist * zoom;
    const target = new THREE.Vector3(0, 0.04, 0);
    this.camera.position.set(Math.sin(b) * Math.cos(a) * d, Math.sin(a) * d, Math.cos(b) * Math.cos(a) * d).add(target);
    // 相機的「上方」跟著轉，正上方俯視時畫面才不會突然翻轉
    this.camera.up.set(-Math.sin(b) * Math.sin(a), Math.cos(a), -Math.cos(b) * Math.sin(a));
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
    // 黏土罐跟著視角水平轉，永遠留在畫面左右兩邊，不會擋住土盤
    for (const side of ['left', 'right'] as const) this.jars[side]?.position.copy(JAR_POS[side]).applyAxisAngle(UP, b);
  }

  update(clay: ClayModel, time: number, jarFill: number): void {
    // 視角平滑地追上目標
    const dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const k = Math.min(1, dt * 10);
    const v = this.view;
    const tv = this.viewTarget;
    if (Math.abs(tv.az - v.az) + Math.abs(tv.tilt - v.tilt) + Math.abs(tv.zoom - v.zoom) > 1e-3) {
      v.az += (tv.az - v.az) * k;
      v.tilt += (tv.tilt - v.tilt) * k;
      v.zoom += (tv.zoom - v.zoom) * k;
      this.applyView();
    }
    this.board.material.uniforms.uTime.value = time;
    for (const side of ['left', 'right'] as const) {
      const f = Math.max(0.02, jarFill);
      const m = this.jarClay[side];
      m.scale.y = JAR_H * 0.95 * f;
      m.position.y = (JAR_H * 0.95 * f) / 2;
    }
    if (clay.version === this.seenVersion) return;
    this.seenVersion = clay.version;
    const pos = this.board.geometry.attributes.position as THREE.BufferAttribute;
    const h = clay.h;
    for (let i = 0; i < h.length; i++) pos.setY(i, h[i] * VERT_SCALE);
    pos.needsUpdate = true;
    this.board.geometry.computeVertexNormals();
    const mk = this.maskAttr.array as Float32Array;
    for (let i = 0; i < h.length; i++) mk[i] = clay.mask[i];
    this.maskAttr.needsUpdate = true;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** 螢幕座標（CSS px）打到黏土表面的底板座標；沒打到回傳 null。 */
  screenToUV(p: Pt, clay: ClayModel): { u: number; v: number } | null {
    const el = this.renderer.domElement;
    const ndc = new THREE.Vector2((p.x / el.clientWidth) * 2 - 1, -(p.y / el.clientHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray;
    // 從最高可能高度往下走，找第一個落到黏土表面以下的點
    const top = new THREE.Plane(new THREE.Vector3(0, 1, 0), -VERT_SCALE);
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const a = ray.intersectPlane(top, new THREE.Vector3());
    const b = ray.intersectPlane(ground, new THREE.Vector3());
    if (!a || !b) return null;
    const STEPS = 96;
    const q = new THREE.Vector3();
    for (let s = 0; s <= STEPS; s++) {
      q.lerpVectors(a, b, s / STEPS);
      const u = q.x + 0.5;
      const v = q.z + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      if (q.y <= clay.heightAt(u, v) * VERT_SCALE) return { u, v };
    }
    const u = b.x + 0.5;
    const v = b.z + 0.5;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
  }

  /** 世界座標投影到螢幕（CSS px）。 */
  project(v: THREE.Vector3): Pt {
    const el = this.renderer.domElement;
    const p = v.clone().project(this.camera);
    return { x: ((p.x + 1) / 2) * el.clientWidth, y: ((1 - p.y) / 2) * el.clientHeight };
  }

  boardPoint(u: number, v: number, clay: ClayModel): Pt {
    return this.project(new THREE.Vector3(u - 0.5, clay.heightAt(u, v) * VERT_SCALE, v - 0.5));
  }

  /** 螢幕上某點是不是在黏土罐上方。 */
  jarAt(p: Pt): 'left' | 'right' | null {
    for (const side of ['left', 'right'] as const) {
      const pos = this.jars[side].position;
      const c = this.project(pos.clone().setY(JAR_H * 0.6));
      const edge = this.project(pos.clone().setY(JAR_H * 0.6).add(new THREE.Vector3(JAR_R, 0, 0).applyAxisAngle(UP, THREE.MathUtils.degToRad(this.view.az))));
      const r = Math.hypot(edge.x - c.x, edge.y - c.y) * 1.9;
      if (Math.hypot(p.x - c.x, p.y - c.y) < r) return side;
    }
    return null;
  }

  jarLabelPoint(side: 'left' | 'right'): Pt {
    const off = new THREE.Vector3(0, 0, JAR_R * 1.3).applyAxisAngle(UP, THREE.MathUtils.degToRad(this.view.az));
    return this.project(this.jars[side].position.clone().setY(-0.01).add(off));
  }
}
