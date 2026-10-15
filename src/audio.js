import * as Tone from 'tone';

export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Chords as [semitones above tonic, quality]. Every progression stays inside
// the natural minor scale, so the minor-pentatonic lead can never clash.
export const PROGRESSIONS = [
  { id: 'night', name: 'Night Drive', chords: [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']] },
  { id: 'dreams', name: 'Neon Dreams', chords: [[0, 'm'], [10, 'M'], [8, 'M'], [10, 'M']] },
  { id: 'heart', name: 'Heartbeat', chords: [[0, 'm'], [5, 'm'], [8, 'M'], [10, 'M']] },
];

// Minor pentatonic across ~1.5 octaves, one interval per lane.
export const LANE_INTERVALS = [0, 3, 5, 7, 10, 12, 15, 17];
export const LANES = LANE_INTERVALS.length;
export const LAYERS = ['drums', 'bass', 'arp', 'pads'];
export const STEPS = 64; // 4 bars of 16ths

export function chordName(key, prog, bar) {
  const [deg, q] = PROGRESSIONS[prog].chords[bar];
  return KEYS[(key + deg) % 12] + (q === 'm' ? 'm' : '');
}

export class Engine {
  constructor() {
    this.listeners = {};
    this.key = 9; // A
    this.bpm = 100;
    this.prog = 0;
    this.layers = { drums: true, bass: true, arp: true, pads: true };
    this.loop = new Set(); // step * LANES + lane
    this.loopArmed = false;
    this.autopilot = false;
    this.ready = false;
    this.paused = false;
    this.held = new Map();
    this.lastManual = new Float64Array(LANES).fill(-1);
    this.motif = null;
    this.autoLane = 3;
    this.queue = []; // visual events, flushed on animation frames
  }

  on(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }

  emit(ev, data) {
    (this.listeners[ev] || []).forEach((fn) => fn(data));
  }

  // Queue an event to fire when the audio clock reaches `time`. Unlike Tone.Draw,
  // late events still fire (UI state must never be skipped); stale cosmetic
  // events are dropped so a backgrounded tab doesn't burst on return.
  at(time, ev, data) {
    this.queue.push({ time, ev, data });
  }

  flush() {
    if (!this.ready || !this.queue.length) return;
    const now = Tone.getContext().currentTime;
    const latest = {}; // stale UI-state events collapse to their newest value
    let i = 0;
    for (; i < this.queue.length; i++) {
      const e = this.queue[i];
      if (e.time > now) break;
      if (now - e.time <= 0.5) this.emit(e.ev, e.data);
      else if (e.ev === 'chord' || e.ev === 'step') latest[e.ev] = e.data;
    }
    if (i) this.queue.splice(0, i);
    for (const ev in latest) this.emit(ev, latest[ev]);
  }

  get transport() {
    return Tone.getTransport();
  }

  get playing() {
    return this.ready && !this.paused;
  }

  async start() {
    if (this.ready) return;
    await Tone.start();
    try {
      // iOS: play through the silent switch
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {}
    Tone.getContext().lookAhead = 0.06;
    this.build();
    await this.reverb.ready;
    this.transport.bpm.value = this.bpm;
    this.transport.scheduleRepeat((t) => this.tick(t), '16n');
    this.ready = true;
    this.transport.start('+0.1');
    this.emit('state');
  }

  build() {
    this.limiter = new Tone.Limiter(-1).toDestination();
    this.master = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.008, release: 0.2 }).connect(this.limiter);
    this.meter = new Tone.Meter({ smoothing: 0.85, normalRange: true });
    this.limiter.connect(this.meter);

    this.reverb = new Tone.Reverb({ decay: 4.5, preDelay: 0.02, wet: 1 });
    const revBus = new Tone.Channel({ volume: -4 }).connect(this.master);
    this.reverb.connect(revBus);
    new Tone.Channel().connect(this.reverb).receive('reverb');

    this.delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.38, wet: 1 });
    const delayFilter = new Tone.Filter(2800, 'lowpass');
    this.delay.chain(delayFilter, this.master);
    new Tone.Channel().connect(this.delay).receive('delay');

    const channel = (vol, rev = -Infinity, dly = -Infinity) => {
      const ch = new Tone.Channel({ volume: vol }).connect(this.master);
      if (rev > -Infinity) ch.send('reverb', rev);
      if (dly > -Infinity) ch.send('delay', dly);
      return ch;
    };

    // Drums
    const drums = channel(0, -20);
    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.045,
      octaves: 6.5,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.1 },
      volume: -3,
    }).connect(drums);

    const snareCh = channel(-2, -3);
    this.snare = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.001, decay: 0.2, sustain: 0 },
      volume: -9,
    }).chain(new Tone.Filter(1100, 'highpass'), snareCh);
    this.snareBody = new Tone.MembraneSynth({
      pitchDecay: 0.015,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.12, sustain: 0 },
      volume: -12,
    }).connect(snareCh);

    this.hat = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.035, sustain: 0 },
      volume: -24,
    }).chain(new Tone.Filter(7500, 'highpass'), drums);

    // Bass: the classic driving octave eighths
    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      filter: { type: 'lowpass', Q: 2.5, rolloff: -24 },
      envelope: { attack: 0.003, decay: 0.18, sustain: 0.35, release: 0.08 },
      filterEnvelope: { attack: 0.002, decay: 0.16, sustain: 0.15, release: 0.1, baseFrequency: 90, octaves: 3.4 },
      volume: -9,
    }).connect(channel(0, -26));

    // Pads
    const padCh = channel(0, -6);
    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 28 },
      envelope: { attack: 0.7, decay: 0.6, sustain: 0.7, release: 2.4 },
      volume: -24,
    });
    this.pad.maxPolyphony = 12;
    this.pad.chain(new Tone.Filter(1500, 'lowpass'), new Tone.Chorus(1.2, 3.5, 0.6).start(), padCh);

    // Arp
    this.arp = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.08 },
      volume: -25,
    }).chain(new Tone.Filter(2400, 'lowpass'), channel(0, -14, -8));

    // Lead (the player's instrument)
    this.lead = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
      envelope: { attack: 0.004, decay: 0.25, sustain: 0.55, release: 0.55 },
      volume: -13,
    });
    this.lead.maxPolyphony = 16;
    this.lead.chain(new Tone.Filter({ frequency: 3400, Q: 1.2, type: 'lowpass' }), channel(0, -9, -11));
  }

  // ----- music theory helpers -----
  leadMidi(lane) {
    const base = 60 + (this.key >= 7 ? this.key - 12 : this.key);
    return base + LANE_INTERVALS[lane];
  }

  chordAt(bar) {
    const [deg, q] = PROGRESSIONS[this.prog].chords[bar];
    return { pc: (this.key + deg) % 12, third: q === 'm' ? 3 : 4 };
  }

  stepAt(time) {
    const tp16 = this.transport.PPQ / 4;
    return Math.round(this.transport.getTicksAtTime(time) / tp16) % STEPS;
  }

  // ----- sequencer -----
  tick(time) {
    const step = this.stepAt(time);
    const bar = step >> 4;
    const s = step & 15;
    const { pc, third } = this.chordAt(bar);

    if (this.layers.drums) {
      if (s % 4 === 0) {
        this.kick.triggerAttackRelease('C1', '8n', time);
        this.at(time, 'kick', { step });
      }
      if (s === 4 || s === 12) {
        this.snare.triggerAttackRelease('8n', time);
        this.snareBody.triggerAttackRelease('G2', '16n', time);
        this.at(time, 'snare', { step });
      }
      // Fill on the last beat of the loop
      const fill = bar === 3 && s >= 13;
      if (fill) {
        this.snare.triggerAttackRelease('16n', time, 0.35 + (s - 13) * 0.2);
        this.at(time, 'snare', { step, fill: true });
      }
      if (s % 2 === 0 || bar === 3) {
        this.hat.triggerAttackRelease('32n', time, s % 4 === 2 ? 1 : 0.45);
      }
    }

    if (this.layers.bass && s % 2 === 0) {
      const pat = [0, 0, 12, 0, 0, 12, 0, 12];
      let root = 24 + pc;
      if (root < 28) root += 12;
      this.bass.triggerAttackRelease(Tone.Frequency(root + pat[s / 2], 'midi').toFrequency(), '16n', time, 0.9);
    }

    if (s === 0) {
      if (this.layers.pads) {
        const r = 48 + pc;
        const notes = [r, r + third, r + 7, r + 12].map((m) => Tone.Frequency(m, 'midi').toFrequency());
        this.pad.triggerAttackRelease(notes, Tone.Time('1m').toSeconds() * 0.96, time, 0.6);
      }
      this.at(time, 'chord', { bar, name: chordName(this.key, this.prog, bar) });
    }

    if (this.layers.arp) {
      const tones = [0, third, 7, 12, 12 + third, 19];
      const order = [0, 1, 2, 3, 4, 5, 4, 3, 2, 3, 4, 5, 3, 2, 1, 2];
      const m = 60 + pc + tones[order[s]];
      this.arp.triggerAttackRelease(Tone.Frequency(m > 84 ? m - 12 : m, 'midi').toFrequency(), '32n', time, 0.7);
    }

    // Loop playback
    for (let lane = 0; lane < LANES; lane++) {
      if (!this.loop.has(step * LANES + lane)) continue;
      if (time - this.lastManual[lane] < 0.15) continue; // just played live
      this.playScheduled(lane, '8n', time, 0.8, 'loop');
    }

    if (this.autopilot) this.autoTick(step, time);

    this.at(time, 'step', { step, bar, s });
  }

  playScheduled(lane, dur, time, vel, source) {
    const f = Tone.Frequency(this.leadMidi(lane), 'midi').toFrequency();
    this.lead.triggerAttackRelease(f, dur, time, vel);
    this.at(time, 'note', { lane, vel, source });
  }

  // Generative melody for VJ mode: a one-bar motif that follows the chords.
  autoTick(step, time) {
    if (!this.motif || step === 0) {
      this.motif = [];
      let lane = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < 16; i++) {
        const p = i % 4 === 0 ? 0.6 : i % 2 === 0 ? 0.38 : 0.14;
        if (Math.random() < p) {
          lane = Math.max(0, Math.min(LANES - 1, lane + [-2, -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)]));
          this.motif.push({ s: i, lane, long: Math.random() < 0.25 });
        }
      }
    }
    const bar = step >> 4;
    const shift = [0, 1, -1, bar === 3 && Math.random() < 0.5 ? 2 : 0][bar];
    for (const n of this.motif) {
      if (n.s !== (step & 15)) continue;
      const lane = Math.max(0, Math.min(LANES - 1, n.lane + shift));
      this.playScheduled(lane, n.long ? '4n' : '16n', time, 0.75, 'auto');
    }
  }

  // ----- live input -----
  noteOn(lane, vel = 0.9) {
    if (!this.ready || this.held.has(lane)) return;
    const t = Tone.immediate();
    const f = Tone.Frequency(this.leadMidi(lane), 'midi').toFrequency();
    this.lead.triggerAttack(f, t, vel);
    this.held.set(lane, f);
    this.lastManual[lane] = t;
    if (this.loopArmed && this.playing) {
      const step = this.stepAt(t);
      this.loop.add(step * LANES + lane);
      this.emit('loop');
    }
    this.emit('note', { lane, vel, source: 'live' });
  }

  noteOff(lane) {
    const f = this.held.get(lane);
    if (f == null) return;
    this.held.delete(lane);
    this.lead.triggerRelease(f, Tone.immediate());
  }

  releaseAll() {
    for (const lane of [...this.held.keys()]) this.noteOff(lane);
  }

  // ----- settings -----
  togglePlay() {
    if (!this.ready) return;
    if (this.playing) {
      this.paused = true;
      this.transport.pause();
      this.pad.releaseAll();
      this.releaseAll();
    } else {
      this.paused = false;
      this.transport.start('+0.05');
    }
    this.emit('state');
  }

  setKey(k) {
    this.releaseAll();
    this.key = ((k % 12) + 12) % 12;
    this.emit('state');
  }

  setBpm(bpm) {
    this.bpm = Math.max(70, Math.min(150, Math.round(bpm)));
    if (this.ready) this.transport.bpm.rampTo(this.bpm, 0.2);
    this.emit('state');
  }

  setProgression(i) {
    this.prog = ((i % PROGRESSIONS.length) + PROGRESSIONS.length) % PROGRESSIONS.length;
    this.emit('state');
  }

  setLayer(name, on) {
    this.layers[name] = on;
    if (name === 'pads' && !on && this.pad) this.pad.releaseAll();
    this.emit('state');
  }

  toggleLoopArm() {
    this.loopArmed = !this.loopArmed;
    this.emit('state');
  }

  clearLoop() {
    this.loop.clear();
    this.emit('loop');
  }

  level() {
    if (!this.meter) return 0;
    const v = this.meter.getValue();
    return Array.isArray(v) ? v[0] : v;
  }
}
