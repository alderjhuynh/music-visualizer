const els = {
  canvas: document.getElementById('canvas'),
  wave: document.getElementById('waveCanvas'),
  albumSwitcher: document.getElementById('albumSwitcher'),
  keyLabel: document.getElementById('keyLabel'),
  notesValues: document.getElementById('notesValues'),
  onsetStat: document.getElementById('onsetStat'),
  beatStat: document.getElementById('beatStat'),
  meterL: document.getElementById('meterL'),
  meterR: document.getElementById('meterR'),
  barCount: document.getElementById('barCount'),
  beatCount: document.getElementById('beatCount'),
  timeCount: document.getElementById('timeCount'),
  timeReadout: document.getElementById('timeReadout'),
  progressFill: document.getElementById('progressFill'),
  progressTrack: document.getElementById('progressTrack'),
  marquee: document.getElementById('marquee'),
  edgeRight: document.getElementById('edgeRight'),
  tracklist: document.getElementById('tracklist'),
  playBtn: document.getElementById('playBtn'),
  modeBtn: document.getElementById('modeBtn'),
  audio: document.getElementById('audio'),
};

const ctx2d = els.canvas.getContext('2d');
const waveCtx = els.wave.getContext('2d');

let audioCtx, sourceNode, analyser, splitter, analyserL, analyserR;
let freqData, timeData, freqDataL, freqDataR;
let current = null; // per-track analysis json
let albums = [];
let currentAlbum = null; // { id, title, theme, path }
let manifest = [];
let marqueeOffset = 0;
let edgeOffset = 0;
let currentIndex = 0;
let playMode = 'sequential';

/* bkg circle scatter */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const bgCircles = (() => {
  const rand = mulberry32(1337);
  const list = [];
  const COUNT = 52;
  for (let i = 0; i < COUNT; i++) {
    list.push({
      xFrac: 0.015 + rand() * 0.58,
      yFrac: 0.02 + rand() * 0.5,
      rBase: 3 + rand() * rand() * 100,
      filled: rand() < 0.14,
      alpha: 0.14 + rand() * 0.6,
      speed: 0.25 + rand() * 1.3,
      phase: rand() * Math.PI * 2,
      lineW: 1 + rand() * 2.4,
    });
  }
  return list;
})();

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

let edgeUnitHeight = 1;
let marqueeUnitWidth = 1;

function buildLoopedText(el, unit, vertical) {
  el.textContent = unit;
  const roughUnitSize = Math.max(1, vertical ? el.scrollHeight : el.scrollWidth);
  const trackSize = vertical ? el.parentElement.clientHeight : el.parentElement.clientWidth;
  const reps = Math.max(4, Math.ceil((trackSize * 2) / roughUnitSize) + 1);
  el.textContent = unit.repeat(reps);
  const totalSize = Math.max(1, vertical ? el.scrollHeight : el.scrollWidth);
  return totalSize / reps;
}

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [els.canvas, els.wave]) {
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, rect.width * dpr);
    c.height = Math.max(1, rect.height * dpr);
  }
}
window.addEventListener('resize', () => {
  resizeCanvases();
  if (current && currentAlbum && currentAlbum.theme !== 'pastoral') {
    edgeUnitHeight = buildLoopedText(els.edgeRight, `${current.title}  \u2014  `, true);
    marqueeUnitWidth = buildLoopedText(els.marquee, `${current.tag}   \u2014   `, false);
  }
});

function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaElementSource(els.audio);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.frequencyBinCount);

  splitter = audioCtx.createChannelSplitter(2);
  analyserL = audioCtx.createAnalyser();
  analyserR = audioCtx.createAnalyser();
  analyserL.fftSize = 512;
  analyserR.fftSize = 512;
  freqDataL = new Uint8Array(analyserL.frequencyBinCount);
  freqDataR = new Uint8Array(analyserR.frequencyBinCount);

  sourceNode.connect(analyser);
  sourceNode.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  analyser.connect(audioCtx.destination);
}

// theme transition DONT FUCK THIS UP

function applyTheme(theme) {
  const isInitial = !document.body.dataset.theme;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (isInitial || prefersReduced) {
    document.body.dataset.theme = theme;
    return Promise.resolve();
  }
  if (document.startViewTransition) {
    try {
      const vt = document.startViewTransition(() => {
        document.body.dataset.theme = theme;
      });
      return vt.finished.catch(() => {});
    } catch (_) {
    }
  }
  return new Promise((resolve) => {
    const c = els.canvas;
    const prev = c.style.transition;
    c.style.transition = 'opacity 220ms ease';
    c.style.opacity = '0.18';
    setTimeout(() => {
      document.body.dataset.theme = theme;
      requestAnimationFrame(() => {
        c.style.opacity = '1';
        setTimeout(() => {
          c.style.transition = prev;
          if (!c.style.transition) c.style.removeProperty('transition');
          c.style.removeProperty('opacity');
          resolve();
        }, 380);
      });
    }, 220);
  });
}

function albumFromUrl() {
  const requested = new URLSearchParams(window.location.search).get('album');
  if (!requested) return albums[0];
  return albums.find((a) => a.id === requested) || albums[0];
}

function trackIndexFromUrl() {
  const requested = new URLSearchParams(window.location.search).get('track');
  if (!requested) return 0;
  const idx = manifest.findIndex((t) => t.id === requested);
  return idx >= 0 ? idx : 0;
}

async function loadAlbums() {
  const res = await fetch('albums.json');
  albums = await res.json();
  renderAlbumSwitcher();
  const album = albumFromUrl();
  await switchAlbum(album, { updateUrl: false, initialTrack: trackIndexFromUrl() });
}

function renderAlbumSwitcher() {
  els.albumSwitcher.innerHTML = '';
  if (albums.length < 2) return; // nothing to switch between yet
  albums.forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.title;
    btn.classList.toggle('active', currentAlbum && a.id === currentAlbum.id);
    btn.addEventListener('click', () => {
      if (currentAlbum && a.id === currentAlbum.id) return;
      switchAlbum(a, { updateUrl: true, initialTrack: 0 });
    });
    els.albumSwitcher.appendChild(btn);
  });
}

async function switchAlbum(album, { updateUrl = false, initialTrack = 0 } = {}) {
  const wasPlaying = !!(audioCtx && !els.audio.paused);
  if (wasPlaying) els.audio.pause();
  setPlayState(false);

  currentAlbum = album;
  await applyTheme(album.theme);
  document.title = album.title;
  [...els.albumSwitcher.children].forEach((b, i) => b.classList.toggle('active', albums[i].id === album.id));

  const res = await fetch(`${album.path}manifest.json`);
  manifest = await res.json();

  els.tracklist.innerHTML = '';
  manifest.forEach((track, i) => {
    const btn = document.createElement('button');
    btn.textContent = track.title;
    btn.addEventListener('click', () => selectTrack(i, { updateUrl: true }));
    els.tracklist.appendChild(btn);
  });

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('album', album.id);
    url.searchParams.delete('track');
    history.pushState({ album: album.id }, '', url);
  }

  if (manifest.length) {
    await selectTrack(Math.min(initialTrack, manifest.length - 1), { updateUrl: false });
  } else {
    current = null;
    const isPastoralEmpty = album.theme === 'pastoral';
    els.keyLabel.textContent = isPastoralEmpty ? album.title : 'more soon';
    els.notesValues.textContent = '\u2014';
    if (isPastoralEmpty) {
      els.edgeRight.textContent = '';
      els.marquee.textContent = '';
    } else {
      edgeUnitHeight = buildLoopedText(els.edgeRight, `${album.title}  \u2014  `, true);
      marqueeUnitWidth = buildLoopedText(els.marquee, 'tracks coming soon   \u2014   ', false);
    }
    waveCtx.clearRect(0, 0, els.wave.width, els.wave.height);
  }
}

async function selectTrack(index, { updateUrl = false, autoplay = false } = {}) {
  const wasPlaying = !!(audioCtx && !els.audio.paused);
  currentIndex = index;
  const track = manifest[index];
  [...els.tracklist.children].forEach((b, i) => b.classList.toggle('active', i === index));

  const res = await fetch(`${currentAlbum.path}${track.data}`);
  current = await res.json();

  els.audio.src = `${currentAlbum.path}${track.file}`;
  const isPastoral = currentAlbum && currentAlbum.theme === 'pastoral';
  els.keyLabel.textContent = isPastoral ? current.title : current.key;
  if (isPastoral) {
    els.edgeRight.textContent = '';
    els.marquee.textContent = '';
  } else {
    edgeUnitHeight = buildLoopedText(els.edgeRight, `${current.title}  \u2014  `, true);
    marqueeUnitWidth = buildLoopedText(els.marquee, `${current.tag}   \u2014   `, false);
  }
  drawWaveformOverview(els.audio.currentTime || 0, current.duration);

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('album', currentAlbum.id);
    url.searchParams.set('track', track.id);
    history.pushState({ album: currentAlbum.id, track: track.id }, '', url);
  }

  if (autoplay || wasPlaying) {
    ensureAudioGraph();
    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      await els.audio.play();
      setPlayState(true);
    } catch (err) {
      setPlayState(false);
    }
  }
}

function nextTrackIndex() {
  if (manifest.length <= 1) return 0;
  if (playMode === 'shuffle') {
    let idx;
    do { idx = Math.floor(Math.random() * manifest.length); } while (idx === currentIndex);
    return idx;
  }
  return (currentIndex + 1) % manifest.length;
}

window.addEventListener('popstate', () => {
  if (!albums.length) return;
  const album = albumFromUrl();
  if (!currentAlbum || album.id !== currentAlbum.id) {
    switchAlbum(album, { updateUrl: false, initialTrack: trackIndexFromUrl() });
  } else if (manifest.length) {
    selectTrack(trackIndexFromUrl());
  }
});

function drawWaveformOverview(t, dur) {
  const w = els.wave.width, h = els.wave.height;
  waveCtx.clearRect(0, 0, w, h);
  if (!current) return;
  const peaks = current.waveform;
  const n = peaks.length;
  if (!n || !dur) return;

  const windowSec = Math.max(4, Math.min(dur, 14));
  const pxPerSec = w / windowSec;
  const startTime = t - windowSec / 2;
  const step = 2;
  const ink = getComputedStyle(document.body).getPropertyValue('--ink').trim() || '#f2f1ec';
  const inkRgb = hexToRgbTriplet(ink);

  for (let x = 0; x < w; x += step) {
    const timeAtX = startTime + x / pxPerSec;
    if (timeAtX < 0 || timeAtX > dur) continue;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((timeAtX / dur) * n)));
    const p = peaks[idx];
    const barH = Math.max(1, p * h * 0.92);
    const played = timeAtX <= t;
    waveCtx.fillStyle = played ? `rgba(${inkRgb},0.9)` : `rgba(${inkRgb},0.32)`;
    waveCtx.fillRect(x, (h - barH) / 2, step, barH);
  }

  const playheadX = w / 2;
  waveCtx.strokeStyle = `rgba(${inkRgb},0.95)`;
  waveCtx.lineWidth = 2;
  waveCtx.beginPath();
  waveCtx.moveTo(playheadX, 0);
  waveCtx.lineTo(playheadX, h);
  waveCtx.stroke();
}

function hexToRgbTriplet(hex) {
  const m = hex.replace('#', '').trim();
  if (m.length === 3) {
    const r = parseInt(m[0] + m[0], 16), g = parseInt(m[1] + m[1], 16), b = parseInt(m[2] + m[2], 16);
    return `${r},${g},${b}`;
  }
  if (m.length === 6) {
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    return `${r},${g},${b}`;
  }
  return '242,241,236';
}

function countUpTo(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// impact

function drawBackgroundImpact(t, bass, mid, treble) {
  const w = els.canvas.width, h = els.canvas.height;
  ctx2d.clearRect(0, 0, w, h);
  ctx2d.strokeStyle = 'rgba(242,241,236,0.5)';
  ctx2d.fillStyle = 'rgba(242,241,236,1)';

  // the bkg circles
  const scale = w / 1000;
  for (const c of bgCircles) {
    const cx = w * c.xFrac, cy = h * c.yFrac;
    const wobble = Math.sin(t * c.speed + c.phase) * 0.2 + 1;
    const rad = Math.max(1, c.rBase * scale * wobble * (0.72 + bass * 0.85));
    ctx2d.globalAlpha = c.alpha;
    if (c.filled) {
      ctx2d.fillStyle = 'rgba(242,241,236,1)';
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx2d.fill();
    } else {
      ctx2d.lineWidth = c.lineW;
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx2d.stroke();
    }
  }
  ctx2d.globalAlpha = 1;
  ctx2d.lineWidth = 1;

  // big rotate-y arcs
  const acx = w * 0.87, acy = h * 0.15;
  const rings = 34;
  for (let i = 0; i < rings; i++) {
    const rad = (w * 0.014) + i * (w * 0.0145);
    const speed = 0.1 + (i % 4) * 0.05;
    const start = t * speed + i * 0.75;
    const len = 0.5 + treble * 2.1 + 0.35 * Math.sin(i * 1.15 + t * 0.35);
    ctx2d.globalAlpha = 0.28 + 0.6 * (i / rings);
    ctx2d.lineWidth = 16 + treble * 2
    ctx2d.beginPath();
    ctx2d.arc(acx, acy, rad, start, start + len);
    ctx2d.stroke();
  }
  ctx2d.globalAlpha = 1;
  ctx2d.lineWidth = 1;

  // inversion bands
  ctx2d.save();
  ctx2d.strokeStyle = 'rgba(242,241,236,0.9)';
  ctx2d.lineWidth = Math.max(2, w * 0.002);
  ctx2d.beginPath();
  ctx2d.moveTo(w * 0.46, 0);
  ctx2d.lineTo(w * 1.0, h * 0.62);
  ctx2d.stroke();
  ctx2d.restore();

  const tickX = w * 0.5;
  const tickCount = 6;
  ctx2d.strokeStyle = 'rgba(242,241,236,0.7)';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(tickX, h * 0.18);
  ctx2d.lineTo(tickX, h * 0.62);
  ctx2d.stroke();
  for (let i = 0; i < tickCount; i++) {
    const ty = h * 0.30 + i * (h * 0.055);
    const tw = 10 + mid * 40 * (1 - i / tickCount);
    ctx2d.beginPath();
    ctx2d.moveTo(tickX - tw / 2, ty);
    ctx2d.lineTo(tickX + tw / 2, ty);
    ctx2d.stroke();
  }

  // inversion band #2
  ctx2d.beginPath();
  ctx2d.moveTo(w * 0.78, h * 0.0);
  ctx2d.lineTo(w * 0.99, h * 0.18);
  ctx2d.stroke();
}

// pastoral

function drawBackgroundPastoral(t, bass, mid, treble) {
  const w = els.canvas.width, h = els.canvas.height;
  ctx2d.clearRect(0, 0, w, h);

  // wash
  const wash = ctx2d.createLinearGradient(0, 0, 0, h);
  wash.addColorStop(0, 'rgba(154,107,58,0.05)');
  wash.addColorStop(1, 'rgba(122,84,44,0.16)');
  ctx2d.fillStyle = wash;
  ctx2d.fillRect(0, 0, w, h);

  // sun
  const sunX = w * 0.82, sunY = h * 0.2;
  const rings = 11;
  const bassPulse = 0.72 + bass * 0.85;
  for (let i = 0; i < rings; i++) {
    const radBase = (w * 0.018) + i * (w * 0.021);
    const wobble = Math.sin(t * 0.12 + i * 0.6) * (2 + mid * 10);
    const rad = Math.max(1, radBase * bassPulse + wobble);
    ctx2d.globalAlpha = 0.5 - (i / rings) * 0.42;
    ctx2d.strokeStyle = 'rgba(184,138,74,0.95)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.arc(sunX, sunY, rad, 0, Math.PI * 2);
    ctx2d.stroke();
  }
  // sun core
  const coreBase = w * 0.012;
  const coreR = Math.max(1, coreBase * bassPulse);
  ctx2d.globalAlpha = 0.18 + bass * 0.32;
  ctx2d.fillStyle = 'rgba(212,168,102,0.9)';
  ctx2d.beginPath();
  ctx2d.arc(sunX, sunY, coreR * 2.6, 0, Math.PI * 2);
  ctx2d.fill();
  ctx2d.globalAlpha = Math.min(0.95, 0.55 + treble * 0.3 + bass * 0.18);
  ctx2d.fillStyle = 'rgba(212,168,102,0.95)';
  ctx2d.beginPath();
  ctx2d.arc(sunX, sunY, coreR, 0, Math.PI * 2);
  ctx2d.fill();
  ctx2d.globalAlpha = 1;

  // rolling hill horizons
  const baseY = h * 0.7;
  for (let i = 0; i < 3; i++) {
    const amp = (10 + treble * 34) * (1 - i * 0.28);
    const yOff = baseY + i * h * 0.07;
    ctx2d.strokeStyle = `rgba(43,36,24,${0.4 - i * 0.1})`;
    ctx2d.lineWidth = 1.4;
    ctx2d.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const y = yOff + Math.sin(x * 0.0032 + t * (0.08 + i * 0.02) + i * 2.1) * amp;
      if (x === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
  }
}

function drawLiveWaveOverlay() {
  if (!analyser) return;
  analyser.getByteTimeDomainData(timeData);
  const w = els.wave.width, h = els.wave.height;
  const ink = getComputedStyle(document.body).getPropertyValue('--ink').trim() || '#f2f1ec';
  waveCtx.strokeStyle = `rgba(${hexToRgbTriplet(ink)},0.9)`;
  waveCtx.lineWidth = 1.5;
  waveCtx.beginPath();
  const slice = w / timeData.length;
  for (let i = 0; i < timeData.length; i++) {
    const v = timeData[i] / 128.0;
    const y = (v * h) / 2;
    if (i === 0) waveCtx.moveTo(0, y); else waveCtx.lineTo(i * slice, y);
  }
  waveCtx.stroke();
}

function bandAverage(data, loFrac, hiFrac) {
  const lo = Math.floor(data.length * loFrac);
  const hi = Math.floor(data.length * hiFrac);
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += data[i];
  return sum / Math.max(1, hi - lo) / 255;
}

function rms(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function tick() {
  requestAnimationFrame(tick);
  const t = els.audio.currentTime || 0;
  const dur = current ? current.duration : (els.audio.duration || 0);

  let bass = 0, mid = 0, treble = 0;
  if (analyser) {
    analyser.getByteFrequencyData(freqData);
    bass = bandAverage(freqData, 0.0, 0.08);
    mid = bandAverage(freqData, 0.08, 0.35);
    treble = bandAverage(freqData, 0.35, 0.9);
  }
  const theme = currentAlbum ? currentAlbum.theme : 'impact';
  if (theme === 'pastoral') {
    drawBackgroundPastoral(performance.now() / 1000, bass, mid, treble);
  } else {
    drawBackgroundImpact(performance.now() / 1000, bass, mid, treble);
  }

  if (current) {
    drawWaveformOverview(t, dur);
    drawLiveWaveOverlay();

    const frameIdx = Math.min(
      current.notes_timeline.length - 1,
      Math.max(0, Math.floor(t / current.notes_frame_dt))
    );
    const notes = current.notes_timeline[frameIdx] || [];
    els.notesValues.textContent = notes.length ? notes.join(' ') : '\u2014';

    const onsetsPlayed = countUpTo(current.onset_times, t);
    const beatsPlayed = countUpTo(current.beat_times, t);
    const onsetTotal = current.onset_times.length;
    const beatTotal = current.beat_times.length;
    els.onsetStat.textContent = `events ${onsetsPlayed}/${onsetTotal} (${((onsetsPlayed / Math.max(1,onsetTotal)) * 100).toFixed(1)}%)`;
    els.beatStat.textContent = `beats ${beatsPlayed}/${beatTotal} (${((beatsPlayed / Math.max(1,beatTotal)) * 100).toFixed(1)}%)`;

    const beatIndex = Math.max(0, beatsPlayed - 1);
    els.barCount.textContent = String(Math.floor(beatIndex / 4)).padStart(3, '0');
    els.beatCount.textContent = String(beatIndex % 4 + 1).padStart(2, '0');

    const frac = dur > 0 ? Math.min(1, t / dur) : 0;
    els.progressFill.style.width = `${frac * 100}%`;
    els.timeReadout.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  }

  els.timeCount.textContent = fmtTime(t);

  // lr meter
  if (analyserL && analyserR) {
    analyserL.getByteTimeDomainData(freqDataL);
    analyserR.getByteTimeDomainData(freqDataR);
    const lvl = rms(freqDataL) * 3.2;
    const rvl = rms(freqDataR) * 3.2;
    els.meterL.style.setProperty('--level', `${Math.min(100, lvl * 100)}%`);
    els.meterR.style.setProperty('--level', `${Math.min(100, rvl * 100)}%`);
  }

  // hide marquee in pastoral
  if (theme !== 'pastoral') {
    marqueeOffset -= 0.6;
    const width = marqueeUnitWidth || 1;
    if (-marqueeOffset > width) marqueeOffset += width;
    els.marquee.style.transform = `translateX(${marqueeOffset}px)`;

    edgeOffset -= 0.5;
    const edgeSpan = edgeUnitHeight || 1;
    if (-edgeOffset > edgeSpan) edgeOffset += edgeSpan;
    els.edgeRight.style.transform = `translateY(${edgeOffset}px)`;
  }
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M8 5.14v14l11-7z"></path></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>';
function setPlayState(isPlaying) {
  els.playBtn.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
  els.playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

// mode logic
const REPEAT_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v3z"></path></svg>';
const REPEAT_ONE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v3z"></path><text x="12" y="14.5" text-anchor="middle" font-size="7" font-family="Helvetica, Arial, sans-serif" fill="currentColor" stroke="none">1</text></svg>';
const SHUFFLE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"></path></svg>';

const MODE_SEQUENCE = ['sequential', 'repeat-one', 'shuffle'];
const MODE_META = {
  sequential: { label: 'Play through album', svg: REPEAT_SVG },
  'repeat-one': { label: 'Repeat one track', svg: REPEAT_ONE_SVG },
  shuffle: { label: 'Shuffle album', svg: SHUFFLE_SVG },
};
function setModeState() {
  const meta = MODE_META[playMode];
  els.modeBtn.innerHTML = meta.svg;
  els.modeBtn.setAttribute('aria-label', `Playback mode: ${meta.label}. Click to change.`);
  els.modeBtn.title = meta.label;
  els.modeBtn.classList.toggle('mode-active', playMode !== 'sequential');
}
function cycleMode() {
  const i = MODE_SEQUENCE.indexOf(playMode);
  playMode = MODE_SEQUENCE[(i + 1) % MODE_SEQUENCE.length];
  setModeState();
}
els.modeBtn.addEventListener('click', cycleMode);
setModeState();

async function togglePlayback() {
  if (!manifest.length) return;
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (els.audio.paused) {
    await els.audio.play();
    setPlayState(true);
  } else {
    els.audio.pause();
    setPlayState(false);
  }
}

els.playBtn.addEventListener('click', togglePlayback);

window.addEventListener('keydown', (e) => {
  // left/right → switch albums
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
    if (albums.length < 2 || !currentAlbum) return;
    const ae = document.activeElement;
    const tag = ae ? ae.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae && ae.isContentEditable)) return;
    e.preventDefault();
    const idx = albums.findIndex(a => a.id === currentAlbum.id);
    if (idx < 0) return;
    const nextIdx = e.key === 'ArrowRight'
      ? (idx + 1) % albums.length
      : (idx - 1 + albums.length) % albums.length;
    if (nextIdx !== idx) switchAlbum(albums[nextIdx], { updateUrl: true, initialTrack: 0 });
    return;
  }

  if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const ae = document.activeElement;
  const tag = ae ? ae.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae && ae.isContentEditable)) return;
  if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  togglePlayback();
});

els.audio.addEventListener('ended', () => {
  if (!manifest.length) { setPlayState(false); return; }

  if (playMode === 'repeat-one') {
    els.audio.currentTime = 0;
    els.audio.play().then(() => setPlayState(true)).catch(() => setPlayState(false));
    return;
  }

  selectTrack(nextTrackIndex(), { updateUrl: true, autoplay: true });
});

resizeCanvases();
loadAlbums();
tick();
