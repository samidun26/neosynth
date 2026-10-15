import { LAYERS, STEPS, LANES } from './audio.js';

// Compact, human-skimmable jam format kept in the URL hash:
//   #jam=1.<theme>.<key>.<bpm>.<prog>.<layerBits>.<notes>
// notes: each (step * LANES + lane) as 2 base-36 chars.

export function encodeJam({ theme, key, bpm, prog, layers, loop }) {
  const bits = LAYERS.reduce((acc, l, i) => acc | (layers[l] ? 1 << i : 0), 0);
  const notes = [...loop].sort((a, b) => a - b).map((n) => n.toString(36).padStart(2, '0')).join('');
  return ['1', theme, key, bpm, prog, bits, notes].join('.');
}

export function decodeJam(str) {
  try {
    const [v, theme, key, bpm, prog, bits, notes = ''] = str.split('.');
    if (v !== '1') return null;
    const loop = new Set();
    for (let i = 0; i + 1 < notes.length; i += 2) {
      const n = parseInt(notes.slice(i, i + 2), 36);
      if (Number.isFinite(n) && n >= 0 && n < STEPS * LANES) loop.add(n);
    }
    const layers = {};
    LAYERS.forEach((l, i) => (layers[l] = !!(Number(bits) & (1 << i))));
    return {
      theme: Number(theme) || 0,
      key: (Number(key) || 0) % 12,
      bpm: Number(bpm) || 100,
      prog: Number(prog) || 0,
      layers,
      loop,
    };
  } catch {
    return null;
  }
}

export function jamFromLocation() {
  const m = location.hash.match(/jam=([0-9a-z.]+)/i);
  return m ? decodeJam(m[1]) : null;
}

export function jamUrl(state) {
  const url = new URL(location.href);
  url.hash = 'jam=' + encodeJam(state);
  return url.toString();
}
