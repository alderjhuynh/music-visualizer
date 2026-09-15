const els = {
  canvas: document.getElementById('canvas'),
  wave: document.getElementById('waveCanvas'),
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
  audio: document.getElementById('audio'),
};

const ctx2d = els.canvas.getContext('2d');
const waveCtx = els.wave.getContext('2d');

let audioCtx, sourceNode, analyser, splitter, analyserL, analyserR;
let freqData, timeData, freqDataL, freqDataR;
let current = null; // per-track analysis json
let manifest = [];
let marqueeOffset = 0;
let edgeOffset = 0;

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
  if (current) {
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

function trackIndexFromUrl() {
  const requested = new URLSearchParams(window.location.search).get('track');
  if (!requested) return 0;
  const idx = manifest.findIndex((t) => t.id === requested);
  return idx >= 0 ? idx : 0;
}

async function loadManifest() {
  const res = await fetch('manifest.json');
  manifest = await res.json();
  els.tracklist.innerHTML = '';
  manifest.forEach((track, i) => {
    const btn = document.createElement('button');
    btn.textContent = track.title;
    btn.addEventListener('click', () => selectTrack(i, { updateUrl: true }));
    els.tracklist.appendChild(btn);
  });
  if (manifest.length) selectTrack(trackIndexFromUrl());
}

async function selectTrack(index, { updateUrl = false } = {}) {
  const track = manifest[index];
  [...els.tracklist.children].forEach((b, i) => b.classList.toggle('active', i === index));

  const res = await fetch(track.data);
  current = await res.json();

  els.audio.src = track.file;
  els.keyLabel.textContent = current.key;
  edgeUnitHeight = buildLoopedText(els.edgeRight, `${current.title}  \u2014  `, true);
  marqueeUnitWidth = buildLoopedText(els.marquee, `${current.tag}   \u2014   `, false);
  drawWaveformOverview(els.audio.currentTime || 0, current.duration);

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('track', track.id);
    history.pushState({ track: track.id }, '', url);
  }
}

window.addEventListener('popstate', () => {
  if (!manifest.length) return;
  selectTrack(trackIndexFromUrl());
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

  for (let x = 0; x < w; x += step) {
    const timeAtX = startTime + x / pxPerSec;
    if (timeAtX < 0 || timeAtX > dur) continue;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((timeAtX / dur) * n)));
    const p = peaks[idx];
    const barH = Math.max(1, p * h * 0.92);
    const played = timeAtX <= t;
    waveCtx.fillStyle = played ? 'rgba(242,241,236,0.9)' : 'rgba(242,241,236,0.32)';
    waveCtx.fillRect(x, (h - barH) / 2, step, barH);
  }

  const playheadX = w / 2;
  waveCtx.strokeStyle = 'rgba(242,241,236,0.95)';
  waveCtx.lineWidth = 2;
  waveCtx.beginPath();
  waveCtx.moveTo(playheadX, 0);
  waveCtx.lineTo(playheadX, h);
  waveCtx.stroke();
}

function countUpTo(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function drawBackground(t, bass, mid, treble) {
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

function drawLiveWaveOverlay() {
  if (!analyser) return;
  analyser.getByteTimeDomainData(timeData);
  const w = els.wave.width, h = els.wave.height;
  waveCtx.strokeStyle = 'rgba(242,241,236,0.9)';
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
  drawBackground(performance.now() / 1000, bass, mid, treble);

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

  // marquee
  marqueeOffset -= 0.6;
  const width = marqueeUnitWidth || 1;
  if (-marqueeOffset > width) marqueeOffset += width;
  els.marquee.style.transform = `translateX(${marqueeOffset}px)`;

  edgeOffset -= 0.5;
  const edgeSpan = edgeUnitHeight || 1;
  if (-edgeOffset > edgeSpan) edgeOffset += edgeSpan;
  els.edgeRight.style.transform = `translateY(${edgeOffset}px)`;
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M8 5.14v14l11-7z"></path></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>';
function setPlayState(isPlaying) {
  els.playBtn.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
  els.playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

async function togglePlayback() {
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
  if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const ae = document.activeElement;
  const tag = ae ? ae.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae && ae.isContentEditable)) return;
  if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  togglePlayback();
});

els.audio.addEventListener('ended', () => { setPlayState(false); });

resizeCanvases();
loadManifest();
tick();