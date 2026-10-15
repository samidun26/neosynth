import './style.css';
import { Engine, KEYS, PROGRESSIONS, LANE_INTERVALS, LANES, LAYERS, STEPS, chordName } from './audio.js';
import { World, laneColor } from './scene.js';
import { THEMES } from './themes.js';
import { Recorder, download } from './recorder.js';
import { jamFromLocation, jamUrl } from './share.js';

const $ = (sel) => document.querySelector(sel);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const LANE_CODES = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'];
const LAYER_LABELS = { drums: 'Drums', bass: 'Bass', arp: 'Arp', pads: 'Pads' };
const PREFS_KEY = 'neon-highway:prefs';

const engine = new Engine();
const world = new World($('#scene'), { reducedMotion });
const recorder = new Recorder($('#scene'), engine);

const state = {
  theme: 0,
  started: false,
  starting: false,
  vj: false,
  energy: 0,
  step: -1,
  laneCss: [],
  holds: new Int8Array(LANES),
  shared: null,
};

// ---------- persistence ----------
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || null;
  } catch {
    return null;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ theme: state.theme, key: engine.key, bpm: engine.bpm, prog: engine.prog, layers: engine.layers }),
    );
  } catch {}
}

function applySettings(s) {
  if (!s) return;
  if (Number.isInteger(s.theme)) state.theme = Math.max(0, Math.min(THEMES.length - 1, s.theme));
  if (Number.isInteger(s.key)) engine.key = ((s.key % 12) + 12) % 12;
  if (s.bpm) engine.bpm = Math.max(70, Math.min(150, s.bpm));
  if (Number.isInteger(s.prog)) engine.prog = Math.max(0, Math.min(PROGRESSIONS.length - 1, s.prog));
  if (s.layers) LAYERS.forEach((l) => typeof s.layers[l] === 'boolean' && (engine.layers[l] = s.layers[l]));
  if (s.loop) engine.loop = new Set(s.loop);
}

// ---------- toast ----------
let toastTimer;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

// ---------- theme ----------
function applyTheme(i, instant = false) {
  state.theme = (i + THEMES.length) % THEMES.length;
  const t = THEMES[state.theme];
  world.setTheme(t, instant);
  const root = document.documentElement.style;
  root.setProperty('--ui', t.grid);
  root.setProperty('--ui2', t.accent);
  root.setProperty('--sun', t.sunTop);
  root.setProperty('--sun2', t.sunBottom);
  document.querySelector('meta[name="theme-color"]').content = t.skyTop;
  state.laneCss = Array.from({ length: LANES }, (_, k) => '#' + laneColor(t, k).getHexString());
  document.querySelectorAll('.pad').forEach((p, k) => p.style.setProperty('--c', state.laneCss[k]));
  document.querySelectorAll('.swatch').forEach((s, k) => s.setAttribute('aria-checked', String(k === state.theme)));
  drawRoll();
}

// ---------- build UI ----------
function buildPads() {
  const wrap = $('#pads');
  wrap.innerHTML = '';
  for (let i = 0; i < LANES; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pad';
    b.dataset.lane = i;
    b.innerHTML = `<span class="pad__key">${LANE_CODES[i].slice(3)}</span><span class="pad__note"></span>`;
    wrap.appendChild(b);
  }
  updatePadNotes();
}

function updatePadNotes() {
  document.querySelectorAll('.pad').forEach((p, i) => {
    const note = KEYS[(engine.key + LANE_INTERVALS[i]) % 12];
    p.querySelector('.pad__note').textContent = note;
    p.setAttribute('aria-label', `Play ${note}${coarse ? '' : `, key ${LANE_CODES[i].slice(3)}`}`);
  });
}

function buildStudio() {
  const sw = $('#swatches');
  THEMES.forEach((t, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.style.cssText = `--s-top:${t.sunTop};--s-bot:${t.sunBottom};--s-grid:${t.grid};--s-ground:${t.skyMid}`;
    b.innerHTML = `<span class="swatch__art" style="background:linear-gradient(180deg, ${t.skyTop}, ${t.skyMid} 55%, ${t.horizon})"></span>${t.name}`;
    b.addEventListener('click', () => {
      applyTheme(i);
      savePrefs();
    });
    sw.appendChild(b);
  });

  const progs = $('#progs');
  PROGRESSIONS.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = p.name;
    b.addEventListener('click', () => engine.setProgression(i));
    progs.appendChild(b);
  });

  const keys = $('#keys');
  KEYS.forEach((k, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = k + 'm';
    b.setAttribute('aria-label', `${k} minor`);
    b.addEventListener('click', () => engine.setKey(i));
    keys.appendChild(b);
  });

  const layers = $('#layers');
  LAYERS.forEach((l, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'layer';
    b.dataset.layer = l;
    b.innerHTML = `<span>${LAYER_LABELS[l]}</span><kbd>${i + 1}</kbd><span class="layer__sw" aria-hidden="true"></span>`;
    b.addEventListener('click', () => engine.setLayer(l, !engine.layers[l]));
    layers.appendChild(b);
  });

  const tempo = $('#tempo');
  tempo.addEventListener('input', () => engine.setBpm(Number(tempo.value)));
}

function syncUI() {
  document.querySelectorAll('#progs button').forEach((b, i) => b.setAttribute('aria-checked', String(i === engine.prog)));
  document.querySelectorAll('#keys button').forEach((b, i) => b.setAttribute('aria-checked', String(i === engine.key)));
  document.querySelectorAll('.layer').forEach((b) => b.setAttribute('aria-pressed', String(engine.layers[b.dataset.layer])));
  const tempo = $('#tempo');
  tempo.value = engine.bpm;
  tempo.style.setProperty('--p', `${((engine.bpm - 70) / 80) * 100}%`);
  $('#tempo-out').textContent = `${engine.bpm} BPM`;
  world.setBpm(engine.bpm);

  const loopBtn = $('#btn-loop');
  loopBtn.setAttribute('aria-pressed', String(engine.loopArmed));
  $('#loop-label').textContent = engine.loopArmed ? 'Rec' : 'Loop';

  const playing = !state.started || engine.playing;
  const playBtn = $('#btn-play');
  playBtn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  playBtn.dataset.tip = `${playing ? 'Pause' : 'Play'} · Space`;
  if (state.started) world.setMode(engine.playing ? 'playing' : 'paused');

  if (!engine.ready) $('#chord-name').textContent = chordName(engine.key, engine.prog, 0);
  updatePadNotes();
  drawRoll();
}

// ---------- loop roll ----------
const roll = $('#roll');
const rctx = roll.getContext('2d');
function drawRoll() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = roll.clientWidth;
  const h = roll.clientHeight;
  if (!w || !h) return;
  if (roll.width !== Math.round(w * dpr) || roll.height !== Math.round(h * dpr)) {
    roll.width = Math.round(w * dpr);
    roll.height = Math.round(h * dpr);
  }
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.clearRect(0, 0, w, h);
  const padX = 8;
  const padY = 6;
  const cw = (w - padX * 2) / STEPS;
  const ch = (h - padY * 2) / LANES;

  // Bar + beat guides
  for (let s = 0; s <= STEPS; s += 4) {
    rctx.fillStyle = s % 16 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)';
    rctx.fillRect(padX + s * cw - 0.5, padY, 1, h - padY * 2);
  }

  // Playhead
  if (state.step >= 0) {
    rctx.fillStyle = engine.loopArmed ? 'rgba(255,59,92,0.55)' : 'rgba(255,255,255,0.22)';
    rctx.fillRect(padX + state.step * cw, padY - 2, Math.max(2, cw), h - padY * 2 + 4);
  }

  // Notes (lane 0 at the bottom, like pitch)
  for (const n of engine.loop) {
    const s = Math.floor(n / LANES);
    const lane = n % LANES;
    rctx.fillStyle = state.laneCss[lane] || '#fff';
    rctx.shadowColor = state.laneCss[lane] || '#fff';
    rctx.shadowBlur = 6;
    rctx.fillRect(padX + s * cw + 0.5, padY + (LANES - 1 - lane) * ch + 0.5, Math.max(2, cw - 1), Math.max(2, ch - 1));
  }
  rctx.shadowBlur = 0;

  if (!engine.loop.size) {
    rctx.fillStyle = 'rgba(246,238,254,0.38)';
    rctx.font = '500 12px "Space Grotesk", system-ui, sans-serif';
    rctx.textAlign = 'center';
    rctx.textBaseline = 'middle';
    const narrow = w < 300;
    const msg = engine.loopArmed
      ? narrow ? 'Play now · it repeats' : 'Play now, notes repeat every 4 bars'
      : narrow ? 'Tap Loop to record' : 'Press Loop to record a 4-bar pattern';
    rctx.fillText(msg, w / 2, h / 2 + 1);
  }
}

// ---------- notes & holds ----------
function hold(lane) {
  if (!state.started) return;
  state.holds[lane]++;
  if (state.holds[lane] === 1) {
    engine.noteOn(lane);
    padEl(lane)?.classList.add('is-on');
  }
}

function unhold(lane) {
  if (state.holds[lane] <= 0) return;
  state.holds[lane]--;
  if (state.holds[lane] === 0) {
    engine.noteOff(lane);
    padEl(lane)?.classList.remove('is-on');
  }
}

function releaseAllHolds() {
  for (let i = 0; i < LANES; i++) {
    state.holds[i] = 1;
    unhold(i);
  }
  pointerLanes.clear();
}

const padEl = (lane) => document.querySelector(`.pad[data-lane="${lane}"]`);
const echoTimers = [];
function echoPad(lane) {
  const p = padEl(lane);
  if (!p) return;
  p.classList.add('is-echo');
  clearTimeout(echoTimers[lane]);
  echoTimers[lane] = setTimeout(() => p.classList.remove('is-echo'), 160);
}

// Pointer input (pads + road), with glide between lanes.
const pointerLanes = new Map();
function laneAt(x, y, source) {
  if (source === 'road') return world.laneFromPointer(x, y);
  const el = document.elementFromPoint(x, y)?.closest('.pad');
  return el ? Number(el.dataset.lane) : -1;
}

function bindPointer(el, source) {
  el.addEventListener('pointerdown', (e) => {
    if (state.vj) return exitVJ();
    if (!state.started) return;
    if (e.button > 0) return;
    const lane = laneAt(e.clientX, e.clientY, source);
    if (lane < 0) return;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    pointerLanes.set(e.pointerId, { lane, source });
    hold(lane);
  });
  el.addEventListener('pointermove', (e) => {
    const p = pointerLanes.get(e.pointerId);
    if (!p) return;
    const lane = laneAt(e.clientX, e.clientY, p.source);
    if (lane === p.lane || lane < 0) return;
    unhold(p.lane);
    p.lane = lane;
    hold(lane);
  });
  const end = (e) => {
    const p = pointerLanes.get(e.pointerId);
    if (!p) return;
    pointerLanes.delete(e.pointerId);
    unhold(p.lane);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
}

// ---------- engine events ----------
engine.on('note', ({ lane, vel, source }) => {
  world.note(lane, vel, source);
  if (source !== 'live') echoPad(lane);
  state.energy = Math.min(1, state.energy + (source === 'live' ? 0.075 : source === 'auto' ? 0.05 : 0.025));
});
engine.on('kick', () => world.kick());
engine.on('snare', () => world.snare());
engine.on('chord', ({ bar, name }) => {
  const el = $('#chord-name');
  el.textContent = name;
  el.classList.remove('is-pop');
  void el.offsetWidth;
  el.classList.add('is-pop');
  document.querySelectorAll('#chord-bars i').forEach((b, i) => b.classList.toggle('is-on', i === bar));
});
engine.on('step', ({ step }) => {
  state.step = step;
  drawRoll();
  if (state.vj && step === 0) world.nextPreset();
});
engine.on('loop', drawRoll);
engine.on('state', () => {
  syncUI();
  savePrefs();
});

// ---------- actions ----------
async function start() {
  if (state.started || state.starting) return;
  state.starting = true;
  const btn = $('#start');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Warming up…';
  try {
    await engine.start();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Start the engine';
    state.starting = false;
    toast('Audio could not start. Tap again.');
    return;
  }
  state.started = true;
  state.starting = false;
  document.body.classList.add('is-live');
  $('#intro').classList.add('is-leaving');
  setTimeout(() => $('#intro').setAttribute('hidden', ''), 900);
  world.setMode('playing');
  syncUI();
  if (state.shared) {
    setTimeout(() => toast(state.shared.loop.size ? 'Playing the shared jam · press L to add your own notes' : 'Shared vibe loaded · start jamming', 3600), 900);
  } else {
    setTimeout(() => toast(coarse ? 'Tap the pads or the road to play' : 'Play with A S D F G H J K', 3200), 1200);
  }
}

function togglePlay() {
  if (!state.started) return start();
  engine.togglePlay();
}

function toggleLoop() {
  if (!state.started) return;
  engine.toggleLoopArm();
  if (engine.loopArmed && !engine.loop.size) toast('Loop recording · your notes repeat every 4 bars');
  if (!engine.loopArmed && engine.loop.size) toast(`Loop saved · ${engine.loop.size} notes`);
}

function clearLoop() {
  if (!engine.loop.size) return toast('The loop is already empty');
  engine.clearLoop();
  toast('Loop cleared');
}

async function share() {
  const url = jamUrl({ theme: state.theme, key: engine.key, bpm: engine.bpm, prog: engine.prog, layers: engine.layers, loop: engine.loop });
  history.replaceState(null, '', url);
  const n = engine.loop.size;
  const summary = n ? `${n} notes` : 'No loop yet, so only the vibe is shared. Record a loop to share your melody';
  if (coarse && navigator.share) {
    try {
      await navigator.share({ title: 'Neon Highway', text: 'Check out my synthwave jam 🌆', url });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(n ? `Jam link copied · ${summary}` : `Link copied · ${summary}`, 3600);
  } catch {
    window.prompt('Copy your jam link', url);
  }
}

let recTimer;
async function toggleRecord() {
  if (!state.started) return;
  const btn = $('#btn-rec');
  const time = $('#rec-time');
  if (recorder.active) {
    clearInterval(recTimer);
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Record video');
    btn.dataset.tip = 'Record · R';
    btn.querySelector('use').setAttribute('href', '#i-rec');
    time.hidden = true;
    $('#studio-rec').lastChild.textContent = 'Record video';
    const res = await recorder.stop();
    if (res && res.blob.size) {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      download(res.blob, `neon-highway-${stamp}.${res.ext}`);
      toast(`Saved your clip (${res.ext.toUpperCase()}) to downloads`);
    }
    return;
  }
  if (!recorder.supported) return toast("Recording isn't supported in this browser");
  if (!recorder.start()) return;
  btn.setAttribute('aria-pressed', 'true');
  btn.setAttribute('aria-label', 'Stop recording');
  btn.dataset.tip = 'Stop · R';
  btn.querySelector('use').setAttribute('href', '#i-stop');
  $('#studio-rec').lastChild.textContent = 'Stop recording';
  time.hidden = false;
  const tick = () => {
    const s = Math.floor(recorder.elapsed());
    time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 180) toggleRecord();
  };
  tick();
  recTimer = setInterval(tick, 250);
  toast('Recording · press R or the button again to stop');
}

// VJ mode
let idleTimer;
let hintTimer;
function enterVJ() {
  if (!state.started || state.vj) return;
  closeStudio();
  closeHelp();
  releaseAllHolds();
  state.vj = true;
  engine.autopilot = true;
  if (!engine.playing) engine.togglePlay();
  world.setVJ(true);
  world.nextPreset();
  document.body.classList.add('vj', 'show-hint');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => document.body.classList.remove('show-hint'), 3500);
  document.documentElement.requestFullscreen?.().catch(() => {});
  armIdle();
}

function exitVJ() {
  if (!state.vj) return;
  state.vj = false;
  engine.autopilot = false;
  world.setVJ(false);
  document.body.classList.remove('vj', 'show-hint', 'idle');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function armIdle() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (state.vj) idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.vj) exitVJ();
});
document.addEventListener('pointermove', armIdle, { passive: true });

// Studio & help
let lastFocus;
function openStudio() {
  $('#studio').hidden = false;
  $('#btn-studio').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => drawRoll());
}

function closeStudio() {
  $('#studio').hidden = true;
  $('#btn-studio').setAttribute('aria-expanded', 'false');
}

function toggleStudio() {
  $('#studio').hidden ? openStudio() : closeStudio();
}

function openHelp() {
  lastFocus = document.activeElement;
  $('#help').hidden = false;
  $('#help-close').focus();
}

function closeHelp() {
  if ($('#help').hidden) return;
  $('#help').hidden = true;
  lastFocus?.focus?.();
}

// ---------- wiring ----------
$('#start').addEventListener('click', start);
$('#btn-play').addEventListener('click', togglePlay);
$('#btn-theme').addEventListener('click', () => {
  applyTheme(state.theme + 1);
  savePrefs();
  toast(THEMES[state.theme].name, 1200);
});
$('#btn-studio').addEventListener('click', toggleStudio);
$('#studio-close').addEventListener('click', closeStudio);
$('#btn-share').addEventListener('click', share);
$('#studio-share').addEventListener('click', share);
$('#btn-rec').addEventListener('click', toggleRecord);
$('#studio-rec').addEventListener('click', toggleRecord);
$('#btn-vj').addEventListener('click', enterVJ);
$('#btn-help').addEventListener('click', openHelp);
$('#help-close').addEventListener('click', closeHelp);
$('#help').addEventListener('click', (e) => e.target === e.currentTarget && closeHelp());
$('#btn-loop').addEventListener('click', toggleLoop);
$('#btn-clear').addEventListener('click', clearLoop);

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  const inRange = tag === 'INPUT';
  const lane = LANE_CODES.indexOf(e.code);

  if (!state.started) {
    if (e.code === 'Enter' || e.code === 'Space' || lane >= 0) {
      e.preventDefault();
      start();
    }
    return;
  }

  if (state.vj) {
    if (['Escape', 'KeyV', 'Space'].includes(e.code)) {
      e.preventDefault();
      exitVJ();
    }
    return;
  }

  if (lane >= 0) {
    e.preventDefault();
    if (!e.repeat) hold(lane);
    return;
  }
  if (e.repeat && !['ArrowUp', 'ArrowDown'].includes(e.code)) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlay();
      break;
    case 'KeyL':
      toggleLoop();
      break;
    case 'Backspace':
    case 'Delete':
      e.preventDefault();
      clearLoop();
      break;
    case 'KeyT':
      $('#btn-theme').click();
      break;
    case 'KeyM':
      toggleStudio();
      break;
    case 'KeyR':
      toggleRecord();
      break;
    case 'KeyV':
      enterVJ();
      break;
    case 'KeyP':
      engine.setProgression(engine.prog + 1);
      toast(PROGRESSIONS[engine.prog].name, 1200);
      break;
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4': {
      const l = LAYERS[Number(e.code.slice(-1)) - 1];
      engine.setLayer(l, !engine.layers[l]);
      toast(`${LAYER_LABELS[l]} ${engine.layers[l] ? 'on' : 'off'}`, 1000);
      break;
    }
    case 'ArrowUp':
    case 'ArrowDown':
      if (inRange) return;
      e.preventDefault();
      engine.setBpm(engine.bpm + (e.code === 'ArrowUp' ? 2 : -2));
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (inRange) return;
      e.preventDefault();
      engine.setKey(engine.key + (e.code === 'ArrowRight' ? 1 : -1));
      toast(`${KEYS[engine.key]} minor`, 1000);
      break;
    case 'Slash':
      openHelp();
      break;
    case 'Escape':
      if (!$('#help').hidden) closeHelp();
      else closeStudio();
      break;
  }
});

window.addEventListener('keyup', (e) => {
  const lane = LANE_CODES.indexOf(e.code);
  if (lane >= 0) unhold(lane);
  if (e.code === 'Space') e.preventDefault();
});
window.addEventListener('blur', releaseAllHolds);
document.addEventListener('visibilitychange', () => document.hidden && releaseAllHolds());
window.addEventListener('resize', drawRoll);

// ---------- energy loop (UI side) ----------
const driveFill = $('#drive-fill');
let lastT = performance.now();
function uiFrame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  engine.flush();
  state.energy = Math.max(0, state.energy - dt * (state.energy > 0.6 ? 0.14 : 0.09));
  world.setEnergy(state.energy);
  driveFill.style.transform = `scaleX(${state.energy.toFixed(3)})`;
  requestAnimationFrame(uiFrame);
}

// ---------- boot ----------
const shared = jamFromLocation();
applySettings(loadPrefs());
if (shared) {
  applySettings(shared);
  state.shared = shared;
  const n = shared.loop.size;
  const badge = $('#shared-badge');
  badge.innerHTML = `<strong>Shared jam</strong> ${n ? `${n} notes · ` : ''}${PROGRESSIONS[engine.prog].name} in ${KEYS[engine.key]}m · ${engine.bpm} BPM`;
  badge.hidden = false;
  $('#start span').textContent = 'Play the jam';
}

buildPads();
buildStudio();
bindPointer($('#pads'), 'pads');
bindPointer($('#scene'), 'road');
applyTheme(state.theme, true);
syncUI();
world.start();
if (import.meta.env.DEV) window.__nh = { engine, world, state };
requestAnimationFrame(uiFrame);
