# Neon Highway

An endless synthwave drive you play like an instrument. Hit the keys, light up the road. Every note is locked to a minor-pentatonic scale over the backing track, so nothing you play sounds wrong.

## Play

| Input | Action |
| --- | --- |
| `A S D F G H J K` / tap pads / tap the road | Play the 8 lanes (slide across pads to glide) |
| `Space` | Pause / resume |
| `L` · `Backspace` | Loop record on/off · clear loop |
| `1`–`4` | Toggle drums, bass, arp, pads |
| `T` · `P` | Next theme · next chord progression |
| `↑ ↓` · `← →` | Tempo · key |
| `M` · `R` · `V` · `?` | Studio · record video · VJ mode · shortcuts |

**Share:** the link button encodes theme, key, tempo, progression, layers and your 4-bar loop into the URL (`#jam=…`), so friends hear exactly what you made.

**Record:** captures the canvas plus audio to MP4 (or WebM, depending on the browser) and downloads it.

**VJ mode:** hides the UI, goes fullscreen, auto-composes melodies and cuts between camera angles.

## Stack

- **Three.js:** a shader-driven scrolling grid with fbm-ridged mountains, a striped sun, pooled light streaks, sparks and ripples, and a post chain of bloom plus a CRT pass (chromatic aberration, scanlines, grain)
- **Tone.js:** a synthesized drum kit, octave bass, arp, chorus pads and a fat-saw lead, scheduled on the transport and synced to visuals through a lossless event queue
- **Vite:** no framework, about 200 KB gzipped in total

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # dist/
```
