import * as Tone from 'tone';

const TYPES = [
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
];

export class Recorder {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  get supported() {
    return typeof MediaRecorder !== 'undefined' && typeof this.canvas.captureStream === 'function';
  }

  get active() {
    return !!this.rec && this.rec.state === 'recording';
  }

  start() {
    if (!this.supported || this.active) return false;
    if (!this.audioDest) {
      this.audioDest = Tone.getContext().createMediaStreamDestination();
      this.engine.limiter.connect(this.audioDest);
    }
    const stream = new MediaStream([
      ...this.canvas.captureStream(30).getVideoTracks(),
      ...this.audioDest.stream.getAudioTracks(),
    ]);
    const [mimeType, ext] = TYPES.find(([t]) => MediaRecorder.isTypeSupported(t)) || ['', 'webm'];
    this.ext = ext;
    this.chunks = [];
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.startedAt = performance.now();
    return true;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(null);
      const rec = this.rec;
      rec.onstop = () => {
        rec.stream.getVideoTracks().forEach((t) => t.stop());
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'video/webm' });
        this.rec = null;
        resolve({ blob, ext: this.ext });
      };
      rec.stop();
    });
  }

  elapsed() {
    return this.active ? (performance.now() - this.startedAt) / 1000 : 0;
  }
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
