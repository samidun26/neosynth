import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const LANES = 8;
const LANE_W = 2;
const ROAD_HALF = (LANES * LANE_W) / 2; // 8
const COLOR_KEYS = ['skyTop', 'skyMid', 'horizon', 'ground', 'grid', 'grid2', 'sunTop', 'sunBottom', 'accent', 'tail'];

// Bright hues (greens, cyans) carry far more luminance than pinks; cap them so
// every theme blooms with the same exposure.
const LUMA_CAP = { grid: 0.28, grid2: 0.26, accent: 0.34, horizon: 0.26, tail: 0.3, sunTop: 0.6, sunBottom: 0.32 };
function capLuma(c, max) {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (l > max) c.multiplyScalar(max / l);
  return c;
}

export function laneX(lane) {
  return -ROAD_HALF + LANE_W * (lane + 0.5);
}

// Lane colours: a 3-stop gradient sunBottom -> grid -> accent.
export function laneColor(theme, i, target = new THREE.Color()) {
  const t = i / (LANES - 1);
  const a = new THREE.Color(theme.sunBottom);
  const b = new THREE.Color(theme.grid);
  const c = new THREE.Color(theme.accent);
  return t < 0.5 ? target.lerpColors(a, b, t * 2) : target.lerpColors(b, c, (t - 0.5) * 2);
}

const NOISE = /* glsl */ `
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
    return v;
  }
`;

const TERRAIN_VERT = /* glsl */ `
  uniform float uTravel;
  varying vec2 vGrid;
  varying float vH;
  varying vec3 vWorld;
  ${NOISE}
  void main() {
    vec3 p = position;
    float ax = abs(p.x);
    float zz = p.z - uTravel;
    float far = max(0.0, -p.z);
    float valley = ${(ROAD_HALF + 3).toFixed(1)} + far * 0.14;
    float mask = smoothstep(valley, valley + 26.0 + far * 0.05, ax);
    vec2 q = vec2(p.x, zz) * 0.026;
    float n = fbm(q);
    float ridge = 1.0 - abs(n * 2.0 - 1.0);
    float h = (0.45 * n + 0.75 * ridge * ridge) * mask * (10.0 + ax * 0.55);
    p.y += h;
    vH = h;
    vGrid = vec2(p.x, zz);
    vec4 w = modelMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const TERRAIN_FRAG = /* glsl */ `
  uniform vec3 uGround, uGrid, uGrid2, uHorizon, uAccent;
  uniform float uPulse, uEnergy, uRoadBoost;
  uniform float uLane[${LANES}];
  uniform vec3 uLaneCol[${LANES}];
  uniform vec4 uRip[8];
  uniform vec3 uRipCol[8];
  varying vec2 vGrid;
  varying float vH;
  varying vec3 vWorld;

  void main() {
    vec2 c = vGrid / ${LANE_W.toFixed(1)};
    vec2 fw = fwidth(c);
    vec2 g = abs(fract(c - 0.5) - 0.5) / max(fw, vec2(1e-4));
    vec2 l2 = 1.0 - smoothstep(vec2(0.0), vec2(1.35), g);
    float line = max(l2.x, l2.y);
    line = mix(line, 0.12, smoothstep(0.18, 0.7, max(fw.x, fw.y)));

    float ax = abs(vGrid.x);
    float hT = smoothstep(1.0, 34.0, vH);
    vec3 lineCol = mix(uGrid, uGrid2, hT);
    vec3 col = uGround + uGrid2 * 0.035 * hT;

    float intensity = 0.9 + uPulse * 0.8 + uEnergy * 0.4;
    col += lineCol * line * intensity;

    // Road edges
    float ew = max(0.09, fwidth(ax) * 1.2);
    float edge = 1.0 - smoothstep(ew, ew * 2.2, abs(ax - ${ROAD_HALF.toFixed(1)}));
    col += uAccent * edge * (0.85 + uPulse * 0.5) * (1.0 - hT);

    // Lane glow
    if (ax < ${ROAD_HALF.toFixed(1)}) {
      col *= 0.82;
      int li = int(clamp(floor((vGrid.x + ${ROAD_HALF.toFixed(1)}) / ${LANE_W.toFixed(1)}), 0.0, ${(LANES - 1).toFixed(1)}));
      float lv = uLane[li];
      float along = exp(max(0.0, vWorld.z - 2.0) * -0.4) * exp(min(0.0, vWorld.z) * 0.006);
      col += uLaneCol[li] * lv * (0.14 + line * 1.4) * along;
      col += uGrid * uRoadBoost * 0.05;
    }

    // Ripples (kick + notes)
    for (int i = 0; i < 8; i++) {
      vec4 r = uRip[i];
      if (r.w <= 0.002) continue;
      float d = length(vWorld.xz - r.xy);
      float k = (d - r.z) * 0.7;
      float ring = exp(-k * k);
      col += uRipCol[i] * ring * r.w * (0.06 + line * 1.5);
    }

    float dist = length(vWorld.xz - cameraPosition.xz);
    float fog = smoothstep(70.0, 390.0, dist);
    col = mix(col, uHorizon * 0.3, fog);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop, uMid, uHorizon;
  uniform float uPulse;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon * 0.3, uMid, smoothstep(0.0, 0.2, h));
    col = mix(col, uTop, smoothstep(0.16, 0.62, h));
    col += uHorizon * exp(-max(h, 0.0) * 18.0) * (0.16 + uPulse * 0.06);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SUN_FRAG = /* glsl */ `
  uniform vec3 uTop, uBottom;
  uniform float uTime, uPulse, uEnergy;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float y = p.y;
    float band = fract(y * 7.0 + uTime * 0.3);
    float gap = clamp((0.4 - y) / 1.1, 0.0, 1.0) * 0.7;
    if (y < 0.4 && band < gap) discard;
    vec3 col = mix(uBottom, uTop, smoothstep(-0.85, 0.85, y));
    gl_FragColor = vec4(col * (0.72 + uPulse * 0.22 + uEnergy * 0.15), 1.0);
  }
`;

const HALO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPulse;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float a = exp(-r * r * 4.5) * (0.26 + uPulse * 0.12);
    gl_FragColor = vec4(uColor * a, a);
  }
`;

const UV_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STREAK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLife;
  varying vec2 vUv;
  void main() {
    float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
    float a = pow(vUv.y, 2.2) * pow(across, 1.5) * uLife;
    gl_FragColor = vec4(uColor * a * 2.0, a);
  }
`;

const TRAIL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
    float a = pow(1.0 - vUv.x, 1.6) * across;
    gl_FragColor = vec4(uColor * a * 1.6, a);
  }
`;

const STAR_VERT = /* glsl */ `
  attribute float aSeed;
  uniform float uTime, uPR;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.55 + 0.45 * sin(uTime * (0.8 + aSeed * 3.0) + aSeed * 40.0);
    vA = tw * smoothstep(0.04, 0.3, normalize(position).y);
    gl_PointSize = (1.0 + aSeed * 2.4) * uPR;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vA;
    gl_FragColor = vec4(vec3(1.4) * a, a);
  }
`;

const SPARK_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aLife;
  uniform float uPR;
  varying vec3 vColor;
  varying float vLife;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vLife = aLife;
    gl_PointSize = aLife <= 0.0 ? 0.0 : (2.0 + 9.0 * aLife) * uPR * (12.0 / max(1.0, -mv.z));
  }
`;

const SPARK_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vLife;
    gl_FragColor = vec4(vColor * a * 1.8, a);
  }
`;

const CRT_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberr: { value: 0.002 },
    uGrain: { value: 0.035 },
    uScan: { value: 0.06 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: UV_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAberr, uGrain, uScan;
    uniform vec2 uRes;
    varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float d = dot(c, c);
      vec2 off = c * uAberr * (0.6 + d * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float scan = 0.5 + 0.5 * sin(vUv.y * uRes.y * 1.4);
      col *= 1.0 - uScan * scan;
      col *= 1.0 - smoothstep(0.18, 0.75, d) * 0.65;
      col += (h(vUv * uRes + fract(uTime) * 100.0) - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const CAMERA_PRESETS = [
  { pos: [0, 3.3, 10.5], look: [0, 1.0, -30] },
  { pos: [-7, 1.1, 4.5], look: [0, 1.6, -22] },
  { pos: [0, 10, 18], look: [0, 0, -70] },
  { pos: [5.5, 0.7, -4], look: [0, 1.3, -40] },
  { pos: [0, 0.9, -6], look: [0, 6, -80] },
];

export class World {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.mobile = matchMedia('(pointer: coarse)').matches;
    this.pr = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pr);
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1400);
    this.camPos = new THREE.Vector3(...CAMERA_PRESETS[0].pos);
    this.camLook = new THREE.Vector3(...CAMERA_PRESETS[0].look);
    this.camTargetPos = this.camPos.clone();
    this.camTargetLook = this.camLook.clone();
    this.preset = 0;

    // Animated state
    this.time = 0;
    this.travel = 0;
    this.speed = 4;
    this.targetSpeed = 4;
    this.bpm = 100;
    this.energy = 0;
    this.pulse = 0;
    this.snarePulse = 0;
    this.shake = 0;
    this.carX = 0;
    this.carTargetX = 0;
    this.carRoll = 0;
    this.carBounce = 0;
    this.vj = false;
    this.mode = 'attract'; // attract | playing | paused
    this.lane = new Float32Array(LANES);
    this.ripples = Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0));
    this.rippleCols = Array.from({ length: 8 }, () => new THREE.Color());
    this.rippleIdx = 0;

    // Colours: current values (used by uniforms) lerp toward targets.
    this.col = {};
    this.colTarget = {};
    COLOR_KEYS.forEach((k) => {
      this.col[k] = new THREE.Color();
      this.colTarget[k] = new THREE.Color();
    });
    this.laneCols = Array.from({ length: LANES }, () => new THREE.Color());
    this.laneColsTarget = Array.from({ length: LANES }, () => new THREE.Color());

    this.buildSky();
    this.buildSun();
    this.buildTerrain();
    this.buildPylons();
    this.buildGates();
    this.buildCar();
    this.buildStreaks();
    this.buildSparks();
    this.buildPost();

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.frameTimes = [];
    this.clock = new THREE.Clock();
    this.onResize = this.onResize.bind(this);
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  // ---------- builders ----------
  buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { uTop: { value: this.col.skyTop }, uMid: { value: this.col.skyMid }, uHorizon: { value: this.col.horizon }, uPulse: { value: 0 } },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), this.skyMat);
    sky.renderOrder = -10;
    this.scene.add(sky);

    const n = this.mobile ? 700 : 1400;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const y = 0.02 + Math.pow(Math.random(), 0.8) * 0.98;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(theta) * r * 850, y * 850, Math.sin(theta) * r * 850], i * 3);
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPR: { value: this.pr } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(g, this.starMat);
    stars.renderOrder = -9;
    this.scene.add(stars);
  }

  buildSun() {
    this.sunMat = new THREE.ShaderMaterial({
      uniforms: { uTop: { value: this.col.sunTop }, uBottom: { value: this.col.sunBottom }, uTime: { value: 0 }, uPulse: { value: 0 }, uEnergy: { value: 0 } },
      vertexShader: UV_VERT,
      fragmentShader: SUN_FRAG,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sunMat);
    this.sun.scale.setScalar(250);
    this.sun.position.set(0, 62, -700);
    this.scene.add(this.sun);

    this.haloMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.col.sunBottom }, uPulse: { value: 0 } },
      vertexShader: UV_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.haloMat);
    this.halo.scale.setScalar(720);
    this.halo.position.set(0, 62, -760);
    this.halo.renderOrder = -8;
    this.scene.add(this.halo);
  }

  buildTerrain() {
    const segX = this.mobile ? 120 : 170;
    const width = segX * 2;
    const depth = this.mobile ? 400 : 460;
    const geo = new THREE.PlaneGeometry(width, depth, segX, depth / 2);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -depth / 2 + 12);
    this.terrainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTravel: { value: 0 },
        uGround: { value: this.col.ground },
        uGrid: { value: this.col.grid },
        uGrid2: { value: this.col.grid2 },
        uHorizon: { value: this.col.horizon },
        uAccent: { value: this.col.accent },
        uPulse: { value: 0 },
        uEnergy: { value: 0 },
        uRoadBoost: { value: 0 },
        uLane: { value: this.lane },
        uLaneCol: { value: this.laneCols },
        uRip: { value: this.ripples },
        uRipCol: { value: this.rippleCols },
      },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
    });
    this.terrain = new THREE.Mesh(geo, this.terrainMat);
    this.terrain.frustumCulled = false;
    this.scene.add(this.terrain);
  }

  buildPylons() {
    this.pylonCount = 22;
    this.pylonGap = 11;
    const n = this.pylonCount * 2;
    this.poleMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.capMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.poles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 3.2, 0.14), this.poleMat, n);
    this.caps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.14, 0.42), this.capMat, n);
    this.poles.frustumCulled = this.caps.frustumCulled = false;
    this.scene.add(this.poles, this.caps);
    this.dummy = new THREE.Object3D();
  }

  buildGates() {
    this.gateMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.gates = [];
    this.gateGap = 72;
    const w = ROAD_HALF * 2 + 6;
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      const post = new THREE.BoxGeometry(0.22, 7.5, 0.22);
      const l = new THREE.Mesh(post, this.gateMat);
      const r = new THREE.Mesh(post, this.gateMat);
      l.position.set(-w / 2, 3.75, 0);
      r.position.set(w / 2, 3.75, 0);
      const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.22, 0.22, 0.22), this.gateMat);
      top.position.y = 7.5;
      const inner = new THREE.Mesh(new THREE.BoxGeometry(w - 3, 0.08, 0.08), this.gateMat);
      inner.position.y = 6.7;
      g.add(l, r, top, inner);
      this.scene.add(g);
      this.gates.push(g);
    }
  }

  buildCar() {
    const car = new THREE.Group();
    const shape = new THREE.Shape();
    const pts = [
      [-2.15, 0.18], [2.15, 0.18], [2.3, 0.42], [1.15, 0.6], [0.35, 1.02],
      [-0.95, 1.04], [-1.85, 0.78], [-2.2, 0.74],
    ];
    shape.moveTo(...pts[0]);
    pts.slice(1).forEach((p) => shape.lineTo(...p));
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1.9, bevelEnabled: false });
    geo.rotateY(Math.PI / 2);
    geo.translate(-0.95, 0.12, 0);
    this.carBodyMat = new THREE.MeshBasicMaterial({ color: 0x05010c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.carEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    const body = new THREE.Mesh(geo, this.carBodyMat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), this.carEdgeMat);
    car.add(body, edges);

    this.tailMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.04), this.tailMat);
    tail.position.set(0, 0.72, 2.22);
    car.add(tail);

    const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 18);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshBasicMaterial({ color: 0x020005, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.wheelEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    const wheelEdges = new THREE.EdgesGeometry(wheelGeo, 30);
    [[-1, -1.35], [1, -1.35], [-1, 1.4], [1, 1.4]].forEach(([sx, z]) => {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(sx * 0.98, 0.36, z);
      const e = new THREE.LineSegments(wheelEdges, this.wheelEdgeMat);
      e.position.copy(w.position);
      car.add(w, e);
    });

    // Underglow
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.col.accent }, uPulse: { value: 0 } },
      vertexShader: UV_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 7), this.glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.03;
    car.add(glow);

    this.car = car;
    this.scene.add(car);

    // Taillight trails (ribbons following the car's lateral history)
    this.trailN = 26;
    this.trailHist = new Float32Array(this.trailN).fill(0);
    this.trailAcc = 0;
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.col.tail } },
      vertexShader: UV_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.trails = [-0.7, 0.7].map((off) => {
      const g = new THREE.PlaneGeometry(1, 1, this.trailN - 1, 1);
      const m = new THREE.Mesh(g, this.trailMat);
      m.frustumCulled = false;
      m.userData.off = off;
      this.scene.add(m);
      return m;
    });
  }

  buildStreaks() {
    this.streaks = [];
    const geo = new THREE.PlaneGeometry(0.6, 10);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 40; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uLife: { value: 0 } },
        vertexShader: UV_VERT,
        fragmentShader: STREAK_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.scene.add(m);
      this.streaks.push({ mesh: m, life: 0, lane: 0 });
    }
    this.streakIdx = 0;
  }

  buildSparks() {
    const n = (this.sparkN = this.mobile ? 500 : 1000);
    this.sparkPos = new Float32Array(n * 3);
    this.sparkCol = new Float32Array(n * 3);
    this.sparkLife = new Float32Array(n);
    this.sparkVel = new Float32Array(n * 3);
    this.sparkMax = new Float32Array(n).fill(1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.sparkLife, 1).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeo = g;
    this.sparkMat = new THREE.ShaderMaterial({
      uniforms: { uPR: { value: this.pr } },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, this.sparkMat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    this.sparkIdx = 0;
  }

  buildPost() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.pr);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.35, 0.42);
    this.composer.addPass(this.bloom);
    this.crt = new ShaderPass(CRT_SHADER);
    this.composer.addPass(this.crt);
    this.composer.addPass(new OutputPass());
  }

  // ---------- public API ----------
  setTheme(theme, instant = false) {
    COLOR_KEYS.forEach((k) => {
      this.colTarget[k].set(theme[k]);
      if (LUMA_CAP[k]) capLuma(this.colTarget[k], LUMA_CAP[k]);
    });
    for (let i = 0; i < LANES; i++) capLuma(laneColor(theme, i, this.laneColsTarget[i]), 0.32);
    if (instant) {
      COLOR_KEYS.forEach((k) => this.col[k].copy(this.colTarget[k]));
      this.laneCols.forEach((c, i) => c.copy(this.laneColsTarget[i]));
    }
  }

  setMode(mode) {
    this.mode = mode;
  }

  setBpm(bpm) {
    this.bpm = bpm;
  }

  setEnergy(e) {
    this.energy = e;
  }

  setVJ(on) {
    this.vj = on;
    if (!on) this.setPreset(0);
  }

  setPreset(i) {
    this.preset = i;
    const p = CAMERA_PRESETS[i];
    this.camTargetPos.set(...p.pos);
    this.camTargetLook.set(...p.look);
  }

  nextPreset() {
    let i;
    do i = Math.floor(Math.random() * CAMERA_PRESETS.length);
    while (i === this.preset);
    this.setPreset(i);
  }

  addRipple(x, z, color, strength) {
    const r = this.ripples[this.rippleIdx];
    r.set(x, z, 0, strength);
    this.rippleCols[this.rippleIdx].copy(color);
    this.rippleIdx = (this.rippleIdx + 1) % this.ripples.length;
  }

  kick() {
    this.pulse = 1;
    this.carBounce = 1;
    this.addRipple(this.carX, 0, this.col.grid2, 0.5);
  }

  snare() {
    this.snarePulse = 1;
    if (!this.reducedMotion) this.shake = Math.max(this.shake, 0.12);
  }

  note(lane, vel = 0.9, source = 'live') {
    const x = laneX(lane);
    const color = this.laneCols[lane];
    this.lane[lane] = 1;
    if (source !== 'loop' || !this.vj) this.carTargetX = x;

    const s = this.streaks[this.streakIdx];
    this.streakIdx = (this.streakIdx + 1) % this.streaks.length;
    s.life = 1;
    s.mesh.visible = true;
    s.mesh.position.set(x, 0.3, -2.5);
    s.mesh.material.uniforms.uColor.value.copy(color);

    this.addRipple(x, -2, color, 0.5 * vel + 0.15);

    const count = this.mobile ? 14 : 26;
    for (let i = 0; i < count; i++) {
      const j = this.sparkIdx;
      this.sparkIdx = (this.sparkIdx + 1) % this.sparkN;
      this.sparkPos.set([x + (Math.random() - 0.5) * 1.4, 0.2, -1 - Math.random() * 3], j * 3);
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6;
      this.sparkVel.set([Math.cos(a) * sp * 0.6, 4 + Math.random() * 9, Math.sin(a) * sp - 4], j * 3);
      this.sparkCol.set([color.r, color.g, color.b], j * 3);
      const life = 0.6 + Math.random() * 0.8;
      this.sparkMax[j] = life;
      this.sparkLife[j] = 1;
    }
    if (source === 'live' && !this.reducedMotion) this.shake = Math.max(this.shake, 0.05);
  }

  laneFromPointer(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return -1;
    if (hit.z > 8 || hit.z < -160) return -1;
    if (Math.abs(hit.x) > ROAD_HALF + 1.5) return -1;
    return Math.max(0, Math.min(LANES - 1, Math.floor((hit.x + ROAD_HALF) / LANE_W)));
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.baseFov = w / h < 0.8 ? 78 : w / h < 1.2 ? 68 : 60;
    // Lift the frame so the car clears the bottom HUD
    this.camera.setViewOffset(w, h, 0, h * (w / h < 0.8 ? 0.1 : 0.13), w, h);
    this.camera.updateProjectionMatrix();
    this.crt.uniforms.uRes.value.set(w * this.pr, h * this.pr);
  }

  start() {
    this.clock.start();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.update(Math.min(this.clock.getDelta(), 1 / 20));
    };
    loop();
  }

  adaptQuality(dt) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    if (avg > 1 / 42 && this.pr > 0.75) {
      this.pr = Math.max(0.75, this.pr - 0.25);
      this.renderer.setPixelRatio(this.pr);
      this.composer.setPixelRatio(this.pr);
      this.onResize();
    }
  }

  // ---------- frame ----------
  update(dt) {
    this.time += dt;
    const t = this.time;
    const k = 1 - Math.exp(-dt * 2.5);

    COLOR_KEYS.forEach((key) => this.col[key].lerp(this.colTarget[key], k));
    this.laneCols.forEach((c, i) => c.lerp(this.laneColsTarget[i], k));

    // Speed: one grid cell per 16th note when playing
    const base = (this.bpm / 60) * 4 * LANE_W;
    this.targetSpeed = this.mode === 'playing' ? base * (1 + this.energy * 0.75) : this.mode === 'paused' ? 0 : base * 0.45;
    this.speed += (this.targetSpeed - this.speed) * (1 - Math.exp(-dt * 1.8));
    this.travel += this.speed * dt;

    // Decays
    this.pulse *= Math.exp(-dt * 6);
    this.snarePulse *= Math.exp(-dt * 7);
    this.shake *= Math.exp(-dt * 9);
    this.carBounce *= Math.exp(-dt * 10);
    for (let i = 0; i < LANES; i++) this.lane[i] *= Math.exp(-dt * 3.2);
    this.ripples.forEach((r) => {
      if (r.w <= 0) return;
      r.z += dt * 55;
      r.w *= Math.exp(-dt * 1.6);
      if (r.w < 0.003) r.w = 0;
    });

    // Uniforms
    const u = this.terrainMat.uniforms;
    u.uTravel.value = this.travel;
    u.uPulse.value = this.pulse;
    u.uEnergy.value = this.energy;
    this.skyMat.uniforms.uPulse.value = this.pulse;
    this.sunMat.uniforms.uTime.value = t;
    this.sunMat.uniforms.uPulse.value = this.pulse * 0.6 + this.snarePulse * 0.4;
    this.sunMat.uniforms.uEnergy.value = this.energy;
    this.haloMat.uniforms.uPulse.value = this.pulse;
    this.glowMat.uniforms.uPulse.value = this.pulse;
    this.starMat.uniforms.uTime.value = t;
    const sunScale = 250 * (1 + this.pulse * 0.015 + this.energy * 0.04);
    this.sun.scale.setScalar(sunScale);

    // Pylons
    const off = this.travel % this.pylonGap;
    for (let i = 0; i < this.pylonCount; i++) {
      const z = -i * this.pylonGap + off + 10;
      for (let s = 0; s < 2; s++) {
        const idx = i * 2 + s;
        const x = (s ? 1 : -1) * (ROAD_HALF + 2.2);
        this.dummy.position.set(x, 1.6, z);
        this.dummy.updateMatrix();
        this.poles.setMatrixAt(idx, this.dummy.matrix);
        this.dummy.position.y = 3.25;
        this.dummy.updateMatrix();
        this.caps.setMatrixAt(idx, this.dummy.matrix);
      }
    }
    this.poles.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    this.poleMat.color.copy(this.col.grid2).multiplyScalar(0.25);
    this.capMat.color.copy(this.col.accent).multiplyScalar(1.2 + this.pulse * 1.5);

    // Gates
    const goff = this.travel % this.gateGap;
    this.gates.forEach((g, i) => g.position.set(0, 0, -i * this.gateGap + goff - 20));
    this.gateMat.color.copy(this.col.grid).multiplyScalar(0.55 + this.snarePulse * 0.9 + this.energy * 0.35);

    // Car
    this.carX += (this.carTargetX - this.carX) * (1 - Math.exp(-dt * 5));
    const lat = this.carTargetX - this.carX;
    const clamp = (v, m) => Math.max(-m, Math.min(m, v));
    this.carRoll += (clamp(-lat * 0.03, 0.09) - this.carRoll) * (1 - Math.exp(-dt * 8));
    this.car.position.set(this.carX, this.carBounce * 0.06 + Math.sin(t * 9) * 0.008 * (this.speed > 1 ? 1 : 0), 0);
    this.car.rotation.set(-this.carBounce * 0.015, clamp(-lat * 0.035, 0.22), this.carRoll);
    this.carEdgeMat.color.copy(this.col.accent).multiplyScalar(1.4 + this.pulse * 0.8);
    this.wheelEdgeMat.color.copy(this.col.grid).multiplyScalar(1.1);
    this.tailMat.color.copy(this.col.tail).multiplyScalar(1.15 + this.pulse * 0.5);

    // Trails
    this.trailAcc += dt;
    while (this.trailAcc > 1 / 60) {
      this.trailAcc -= 1 / 60;
      this.trailHist.copyWithin(1, 0);
      this.trailHist[0] = this.carX;
    }
    const segLen = Math.max(0.05, this.speed / 60) * 0.9;
    this.trails.forEach((m) => {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < this.trailN; i++) {
        const x = this.trailHist[i] + m.userData.off;
        const z = 2.25 + i * segLen;
        p.setXYZ(i, x, 0.78, z);
        p.setXYZ(i + this.trailN, x, 0.66, z);
      }
      p.needsUpdate = true;
    });

    // Streaks
    for (const s of this.streaks) {
      if (s.life <= 0) continue;
      s.mesh.position.z -= dt * (120 + this.speed);
      s.life -= dt * 0.55;
      s.mesh.material.uniforms.uLife.value = Math.max(0, s.life);
      if (s.life <= 0) s.mesh.visible = false;
    }

    // Sparks
    for (let i = 0; i < this.sparkN; i++) {
      if (this.sparkLife[i] <= 0) continue;
      const j = i * 3;
      this.sparkVel[j + 1] -= 14 * dt;
      this.sparkPos[j] += this.sparkVel[j] * dt;
      this.sparkPos[j + 1] = Math.max(0.05, this.sparkPos[j + 1] + this.sparkVel[j + 1] * dt);
      this.sparkPos[j + 2] += (this.sparkVel[j + 2] + this.speed) * dt;
      this.sparkLife[i] -= dt / this.sparkMax[i];
      if (this.sparkLife[i] < 0) this.sparkLife[i] = 0;
    }
    this.sparkGeo.attributes.position.needsUpdate = true;
    this.sparkGeo.attributes.aColor.needsUpdate = true;
    this.sparkGeo.attributes.aLife.needsUpdate = true;

    // Camera
    if (this.vj) {
      const sway = Math.sin(t * 0.25) * 1.5;
      this.camTargetPos.x += (CAMERA_PRESETS[this.preset].pos[0] + sway - this.camTargetPos.x) * 0.02;
    } else {
      this.camTargetPos.set(this.carX * 0.8, 3.3, 10.5);
      this.camTargetLook.set(this.carX * 0.45, 1.0, -30);
    }
    const ck = 1 - Math.exp(-dt * (this.vj ? 0.8 : 4));
    this.camPos.lerp(this.camTargetPos, ck);
    this.camLook.lerp(this.camTargetLook, ck);
    this.camera.position.copy(this.camPos);
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
    }
    this.camera.lookAt(this.camLook);
    const fov = this.baseFov + this.energy * 7 + this.snarePulse * (this.reducedMotion ? 0 : 0.8);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // Post
    this.bloom.strength = 0.68 + this.energy * 0.4 + this.pulse * 0.08;
    this.crt.uniforms.uTime.value = t;
    this.crt.uniforms.uAberr.value = this.reducedMotion ? 0.0015 : 0.0018 + this.snarePulse * 0.004 + this.energy * 0.002;

    this.composer.render(dt);
    this.adaptQuality(dt);
  }
}
