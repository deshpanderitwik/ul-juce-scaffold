// Frame-clock runtime for the animations in this folder.
//
// An animation is one page, animations/NNN-name/index.html, that loads this
// file and calls Animation({...}). Time comes from the frame number, never
// the wall clock: frame f is always t = f / fps. So a frame looks the same
// every time it is drawn, and an export renders exactly what the preview
// showed, however long each frame takes to draw.
//
//   Animation({
//     width: 1920, height: 1080, fps: 60,
//     duration: 8,         // seconds; default: the score's length + 1, else 10
//     seed: 1,             // for ctx.rand and ctx.hash; ?seed=N overrides it
//     context: '2d',       // '2d', 'webgl', 'webgl2', or null to bring your own (Three.js)
//     score: 'score.mid',  // optional, .mid or .json, relative to the page
//     bpm: 120,            // forces a constant tempo (else the score's own, else 120)
//     audio: 'mix.wav',    // optional: plays along with the preview, muxed into the export
//     alpha: false,        // true: transparent background, exported as ProRes 4444
//     setup(ctx) {},       // build all state here; it runs again whenever time goes backwards
//     update(ctx, dt) {},  // optional: once per frame, in frame order, for simulations
//     draw(ctx) {},        // paint frame ctx.frame
//   });
//
// Two kinds of animation, and the runtime keeps both deterministic:
//   - A pure one has no update(): draw() computes everything from ctx.t,
//     ctx.beat and the score, so any frame can be drawn on its own.
//   - A simulation has update(): the state at frame f is setup() followed by
//     exactly f updates of dt = 1/fps. Seeking backwards re-runs setup() and
//     replays the updates, so state must live in what setup() builds.
// ctx.rand is a seeded stream for setup() and update(). draw() must not pull
// from it (the number of draws differs between preview and export); use
// ctx.hash(i, j, ...) instead, a pure function of its integer arguments.
//
// ctx
//   canvas, g (the drawing context; null when context is null)
//   width, height, fps, frames, duration, bpm
//   frame, t (seconds), beat (from the score's tempo map, or bpm)
//   rand() / rand.range(a, b) / rand.int(a, b) / rand.pick(list)
//   hash(...ints) -> [0, 1)
//   score: null, or { notes, duration, bpm, low, high, beatAt(t), timeAt(beat),
//     sounding(t), starting(t0, t1) }. A note is
//     { n, v, ch, track, start, end, beat, endBeat }: start/end in seconds.
//     A .json score is { bpm?, notes: [{ n, beat, beats, v?, ch? }] }.
//   util: clamp, lerp, invLerp, smoothstep, ease (cubic in-out), easeOut (cubic),
//     easeOutBack (overshoots, then settles), mod
//
// With context '2d' the runtime saves and restores the context around draw()
// and resets its transform, so nothing leaks from one frame to the next. An
// opaque canvas (alpha: false) starts black. With context null, attach your
// own renderer to ctx.canvas at width x height, e.g. for Three.js:
//   new THREE.WebGLRenderer({ canvas: ctx.canvas, preserveDrawingBuffer: true })
//   renderer.setSize(ctx.width, ctx.height, false)
//
// Keys
//   Space play / pause          Left / Right one frame (Shift: one second)
//   Home / End first / last     H hide the controls      E export
//   [ / ] previous / next animation in this folder
// URL: ?t=<seconds> opens at that time, ?seed=<n> overrides the seed.
//
// Export (E) needs the render server, `python3 animations/serve.py`. It
// renders every frame in order to NNN-name/render/frames/*.png (the master,
// alpha included), then encodes NNN-name/render/NNN-name.mp4 (H.264), or a
// ProRes 4444 .mov when alpha is set, with the audio muxed in.
(() => {
'use strict';

const util = {
  clamp: (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)),
  lerp: (a, b, t) => a + (b - a) * t,
  invLerp: (a, b, x) => (x - a) / (b - a),
  smoothstep: (a, b, x) => { const t = util.clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); },
  ease: (t) => { t = util.clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
  easeOut: (t) => 1 - Math.pow(1 - util.clamp(t), 3),
  easeOutBack: (t) => { t = util.clamp(t) - 1; return 1 + 2.70158 * t * t * t + 1.70158 * t * t; },
  mod: (x, n) => ((x % n) + n) % n,
};

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRand(seed) {
  const r = mulberry32(seed);
  r.range = (a, b) => a + (b - a) * r();
  r.int = (a, b) => a + Math.floor(r() * (b - a + 1));   // inclusive
  r.pick = (list) => list[Math.floor(r() * list.length)];
  return r;
}

function makeHash(seed) {
  return (...ns) => {
    let h = seed | 0;
    for (const n of ns) {
      h = Math.imul(h ^ (n | 0), 0x27D4EB2D);
      h ^= h >>> 15;
    }
    return mulberry32(h)();
  };
}

// ---- Score ----------------------------------------------------------------

// raw notes are in ticks; tempos are [{ tick, us }] (microseconds per beat)
function makeScore(raw, ppq, tempos) {
  tempos = tempos.slice().sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
  const segs = [];
  let sec = 0;
  tempos.forEach((tp, i) => {
    if (i > 0) sec += (tp.tick - tempos[i - 1].tick) / ppq * tempos[i - 1].us / 1e6;
    segs.push({ tick: tp.tick, sec, us: tp.us });
  });
  const segFor = (key, x) => { let s = segs[0]; for (const seg of segs) if (seg[key] <= x) s = seg; return s; };
  const secAt = (tick) => { const s = segFor('tick', tick); return s.sec + (tick - s.tick) / ppq * s.us / 1e6; };
  const beatAt = (t) => { const s = segFor('sec', t); return (s.tick + (t - s.sec) * 1e6 / s.us * ppq) / ppq; };

  const notes = raw.map((r) => ({
    n: r.n, v: r.v, ch: r.ch, track: r.track,
    start: secAt(r.on), end: secAt(r.off),
    beat: r.on / ppq, endBeat: r.off / ppq,
  })).sort((a, b) => a.start - b.start || a.n - b.n);

  return {
    notes,
    bpm: 60e6 / segs[0].us,
    duration: notes.reduce((m, x) => Math.max(m, x.end), 0),
    low: notes.reduce((m, x) => Math.min(m, x.n), 127),
    high: notes.reduce((m, x) => Math.max(m, x.n), 0),
    beatAt,
    timeAt: (beat) => secAt(beat * ppq),
    sounding: (t) => notes.filter((x) => x.start <= t && t < x.end),
    starting: (t0, t1) => notes.filter((x) => t0 <= x.start && x.start < t1),
  };
}

// Standard MIDI file, format 0 or 1, metrical time.
function parseMidi(buf) {
  const d = new DataView(buf);
  let p = 0;
  const u8 = () => d.getUint8(p++);
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const id = () => String.fromCharCode(u8(), u8(), u8(), u8());
  const vlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7F); } while (b & 0x80); return v; };

  if (id() !== 'MThd') throw new Error('not a MIDI file');
  const hlen = u32();
  const hstart = p;
  u16();                               // format
  const ntrks = u16();
  const ppq = u16();
  if (ppq & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  p = hstart + hlen;

  const raw = [], tempos = [];
  for (let track = 0; track < ntrks && p < d.byteLength; ) {
    const cid = id(), len = u32(), end = p + len;
    if (cid !== 'MTrk') { p = end; continue; }
    let tick = 0, status = 0;
    const open = new Map();            // ch * 128 + n -> [{ tick, v }], first on pairs with first off
    while (p < end) {
      tick += vlq();
      let b = d.getUint8(p);
      if (b === 0xFF) {
        p++;
        const type = u8(), mlen = vlq();
        if (type === 0x51) tempos.push({ tick, us: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
        p += mlen;
        continue;
      }
      if (b === 0xF0 || b === 0xF7) { p++; p += vlq(); continue; }
      if (b & 0x80) { status = b; p++; }   // otherwise running status
      const hi = status & 0xF0, ch = status & 0x0F;
      if (hi === 0x90 || hi === 0x80) {
        const n = u8(), v = u8(), key = ch * 128 + n;
        if (hi === 0x90 && v > 0) {
          if (!open.has(key)) open.set(key, []);
          open.get(key).push({ tick, v });
        } else {
          const on = open.get(key) && open.get(key).shift();
          if (on) raw.push({ n, v: on.v, ch, track, on: on.tick, off: tick });
        }
      } else if (hi === 0xC0 || hi === 0xD0) p += 1;
      else p += 2;
    }
    for (const [key, ons] of open) for (const on of ons) raw.push({ n: key % 128, v: on.v, ch: key >> 7, track, on: on.tick, off: tick });
    p = end;
    track++;
  }
  return { raw, ppq, tempos };
}

async function loadScore(url, bpm) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('score ' + url + ': HTTP ' + res.status);
  if (/\.json$/i.test(url)) {
    const j = await res.json();
    const raw = j.notes.map((x) => ({ n: x.n, v: x.v ?? 100, ch: x.ch ?? 0, track: 0, on: x.beat, off: x.beat + x.beats }));
    return makeScore(raw, 1, [{ tick: 0, us: 60e6 / (bpm || j.bpm || 120) }]);
  }
  const m = parseMidi(await res.arrayBuffer());
  return makeScore(m.raw, m.ppq, bpm ? [{ tick: 0, us: 60e6 / bpm }] : m.tempos);
}

// ---- Page -----------------------------------------------------------------

const CSS = `
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
  body { display: flex; align-items: center; justify-content: center; }
  body.alpha { background: repeating-conic-gradient(#111 0 25%, #1a1a1a 0 50%) 0 0 / 24px 24px; }
  canvas { display: block; }
  #anim-bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 14px;
    padding: 10px 16px; background: linear-gradient(transparent, rgba(0,0,0,0.85));
    font: 12px/1 ui-monospace, Menlo, monospace; color: #9a9a9a; transition: opacity 0.3s; user-select: none; }
  #anim-bar.hidden { opacity: 0; pointer-events: none; }
  #anim-play { width: 14px; color: #ddd; cursor: pointer; text-align: center; }
  #anim-track { flex: 1; height: 18px; position: relative; cursor: pointer; }
  #anim-track::before { content: ''; position: absolute; left: 0; right: 0; top: 8px; height: 2px; background: #333; }
  #anim-fill { position: absolute; left: 0; top: 8px; height: 2px; background: #ddd; }
  #anim-out { white-space: pre; }
  #anim-msg { position: fixed; left: 16px; top: 14px; font: 12px/1.5 ui-monospace, Menlo, monospace;
    color: #ddd; white-space: pre-wrap; max-width: 80vw; pointer-events: none; }
  #anim-msg.error { color: #ff6b6b; }
`;

function Animation(def) {
  const params = new URLSearchParams(location.search);
  const W = def.width || 1920, H = def.height || 1080, FPS = def.fps || 60;
  const SEED = params.has('seed') ? Number(params.get('seed')) : (def.seed ?? 1);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  if (def.alpha) document.body.classList.add('alpha');

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);

  const bar = document.createElement('div');
  bar.id = 'anim-bar';
  bar.innerHTML = '<div id="anim-play"></div><div id="anim-track"><div id="anim-fill"></div></div><div id="anim-out"></div>';
  document.body.appendChild(bar);
  const msg = document.createElement('div');
  msg.id = 'anim-msg';
  document.body.appendChild(msg);
  const $ = (s) => bar.querySelector(s);

  let msgTimer = 0;
  const say = (text, error = false) => {
    msg.textContent = text;
    msg.className = error ? 'error' : '';
    clearTimeout(msgTimer);
    if (!error && text) msgTimer = setTimeout(() => { msg.textContent = ''; }, 4000);
  };

  const fit = () => {
    const s = Math.min(innerWidth / W, innerHeight / H);
    canvas.style.width = W * s + 'px';
    canvas.style.height = H * s + 'px';
  };
  addEventListener('resize', fit);
  fit();

  const kind = def.context === undefined ? '2d' : def.context;
  const g = kind === '2d' ? canvas.getContext('2d', { alpha: !!def.alpha })
    : kind ? canvas.getContext(kind, { alpha: !!def.alpha, preserveDrawingBuffer: true })
    : null;

  const ctx = {
    canvas, g, width: W, height: H, fps: FPS,
    frames: 0, duration: 0, bpm: 120,
    frame: 0, t: 0, beat: 0,
    rand: null, hash: makeHash(SEED), score: null, util,
  };

  let FRAMES = 1;
  let stateFrame = 0;     // updates applied since setup()
  let shown = -1;         // frame currently on the canvas
  let playing = false, playFrom = 0, playStart = 0;
  let exporting = false, cancelExport = false;
  let broken = false;
  let audio = null;

  const setTime = (f) => {
    ctx.frame = f;
    ctx.t = f / FPS;
    ctx.beat = ctx.score ? ctx.score.beatAt(ctx.t) : ctx.t * ctx.bpm / 60;
  };

  const reset = () => {
    ctx.rand = makeRand(SEED);
    setTime(0);
    if (def.setup) def.setup(ctx);
    stateFrame = 0;
  };

  const render = (f) => {
    if (broken) return;
    try {
      if (def.update) {
        if (f < stateFrame) reset();
        while (stateFrame < f) {
          stateFrame++;
          setTime(stateFrame);
          def.update(ctx, 1 / FPS);
        }
      }
      setTime(f);
      if (g && kind === '2d') { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); }
      try { if (def.draw) def.draw(ctx); }
      finally { if (g && kind === '2d') g.restore(); }
      shown = f;
    } catch (err) {
      broken = true;
      pause();
      say('frame ' + f + ': ' + (err && err.stack || err), true);
      console.error(err);
    }
  };

  const clampFrame = (f) => Math.max(0, Math.min(FRAMES - 1, Math.round(f)));

  function play() {
    if (playing || broken) return;
    if (shown >= FRAMES - 1) render(0);
    playing = true;
    playFrom = shown;
    playStart = performance.now();
    if (audio) { audio.currentTime = shown / FPS; audio.play().catch(() => {}); }
  }

  function pause() {
    playing = false;
    if (audio) audio.pause();
  }

  function seek(f) {
    f = clampFrame(f);
    if (playing) {
      playFrom = f;
      playStart = performance.now();
      if (audio) audio.currentTime = f / FPS;
    }
    render(f);
  }

  // While playing, the audio is the clock if it is running; past its end
  // (or without audio) the wall clock takes over from where it stopped.
  function tick(now) {
    requestAnimationFrame(tick);
    if (exporting) return;
    if (playing) {
      let f = audio && !audio.paused && !audio.ended
        ? Math.floor(audio.currentTime * FPS)
        : playFrom + Math.floor((now - playStart) / 1000 * FPS);
      if (f >= FRAMES) {
        playFrom = 0;
        playStart = now;
        if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
        f = 0;
      }
      if (f !== shown) render(f);
    }
    drawBar();
  }

  const two = (n) => String(n).padStart(2, '0');
  const clock = (t) => two(Math.floor(t / 60)) + ':' + two(Math.floor(t % 60)) + '.' + String(Math.floor((t % 1) * 1000)).padStart(3, '0');

  function drawBar() {
    const f = Math.max(0, shown);
    $('#anim-play').textContent = playing ? '❚❚' : '▶';
    $('#anim-fill').style.width = (FRAMES > 1 ? f / (FRAMES - 1) * 100 : 0) + '%';
    $('#anim-out').textContent = clock(f / FPS) + ' / ' + clock(FRAMES / FPS)
      + '   f ' + f + '/' + (FRAMES - 1)
      + '   beat ' + ctx.beat.toFixed(2)
      + '   seed ' + SEED;
  }

  // Controls show while paused or when the mouse moves; H hides them for good
  // (for screen captures) until pressed again.
  let barHidden = false, idleTimer = 0;
  const showBar = () => {
    if (barHidden) return;
    bar.classList.remove('hidden');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (playing) bar.classList.add('hidden'); }, 1500);
  };
  addEventListener('pointermove', showBar);

  $('#anim-play').addEventListener('click', () => (playing ? pause() : play()));
  const track = $('#anim-track');
  const scrub = (e) => {
    const r = track.getBoundingClientRect();
    seek(util.clamp((e.clientX - r.left) / r.width) * (FRAMES - 1));
  };
  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId);
    scrub(e);
    const move = (ev) => scrub(ev);
    const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
  });

  // [ and ] step through the numbered animations, read from the server's
  // directory listing, so a new folder joins without being registered.
  const here = location.pathname.split('/').filter((s) => s && s !== 'index.html').pop();
  let siblings = null;
  fetch('../').then((r) => r.text()).then((html) => {
    siblings = [...html.matchAll(/href="(\d{3}-[^"\/]+)\/"/g)].map((m) => m[1]).sort();
  }).catch(() => {});

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (exporting) {
      if (e.key === 'Escape') cancelExport = true;
      return;
    }
    const k = e.key;
    if (k === ' ') { playing ? pause() : play(); }
    else if (k === 'ArrowLeft') seek(shown - (e.shiftKey ? FPS : 1));
    else if (k === 'ArrowRight') seek(shown + (e.shiftKey ? FPS : 1));
    else if (k === 'Home') seek(0);
    else if (k === 'End') seek(FRAMES - 1);
    else if (k === 'h' || k === 'H') { barHidden = !barHidden; bar.classList.toggle('hidden', barHidden); if (!barHidden) showBar(); }
    else if (k === 'e' || k === 'E') exportFrames();
    else if ((k === '[' || k === ']') && siblings) {
      const i = siblings.indexOf(here);
      const to = siblings[i + (k === ']' ? 1 : -1)];
      if (i >= 0 && to) location.href = '../' + to + '/';
    } else return;
    e.preventDefault();
    showBar();
  });

  const post = async (path, body, json = true) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': json ? 'application/json' : 'image/png' },
      body: json ? JSON.stringify(body) : body,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.ok === false) throw new Error(out.error || path + ': HTTP ' + res.status);
    return out;
  };

  async function exportFrames() {
    if (exporting || broken) return;
    pause();
    const back = Math.max(0, shown);
    const anim = location.pathname.replace(/index\.html$/, '');
    try {
      await post('/render/start', { anim });
    } catch (err) {
      say('Export needs the render server: python3 animations/serve.py\n(' + err.message + ')', true);
      return;
    }
    exporting = true;
    cancelExport = false;
    const t0 = performance.now();
    const inflight = new Set();
    try {
      reset();
      for (let f = 0; f < FRAMES; f++) {
        if (cancelExport) throw new Error('cancelled');
        render(f);
        if (broken) throw new Error('drawing failed at frame ' + f);
        // toBlob copies the canvas when called, so it runs right after draw.
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        const up = post('/render/frame?anim=' + encodeURIComponent(anim) + '&n=' + f, blob, false);
        inflight.add(up);
        up.finally(() => inflight.delete(up)).catch(() => {});
        if (inflight.size >= 4) await Promise.race(inflight);
        say('Exporting frame ' + (f + 1) + ' / ' + FRAMES + '   (Esc cancels)');
        drawBar();
      }
      await Promise.all(inflight);
      say('Encoding...');
      const out = await post('/render/finish', { anim, fps: FPS, alpha: !!def.alpha, audio: def.audio || null });
      say('Exported ' + FRAMES + ' frames in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s\n' + out.output);
    } catch (err) {
      await Promise.allSettled(inflight);
      if (!broken) say('Export stopped: ' + err.message, true);
    } finally {
      exporting = false;
      if (!broken) render(back);
    }
  }

  async function boot() {
    if (def.score) {
      ctx.score = await loadScore(def.score, def.bpm);
      ctx.bpm = ctx.score.bpm;
    } else {
      ctx.bpm = def.bpm || 120;
    }
    ctx.duration = def.duration ?? (ctx.score ? ctx.score.duration + 1 : 10);
    FRAMES = Math.max(1, Math.round(ctx.duration * FPS));
    ctx.frames = FRAMES;
    if (def.audio) {
      audio = new Audio(def.audio);
      audio.preload = 'auto';
    }
    reset();
    render(clampFrame(Number(params.get('t') || 0) * FPS));
    showBar();
    requestAnimationFrame(tick);
  }

  window.__anim = { ctx, seek, play, pause, exportFrames, get shown() { return shown; }, get frames() { return FRAMES; } };
  boot().catch((err) => { broken = true; say(String(err && err.stack || err), true); console.error(err); });
}

window.Animation = Animation;
})();
