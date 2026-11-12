// 画面・カメラ・センサーの配線。判定そのものは logic.js にある。
import {
  tiltFromOrientation, judgeTilt, parseAspect, cropRect,
  silhouetteLayout, validateTemplate, secondsBetween, upVector,
} from './logic.js';
import {
  bodyFromMediaPipe, pickSubject, judgePose, nextInstruction, updateAutoShoot,
} from './pose-logic.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const BURST_COUNT = 5;
const BURST_INTERVAL_MS = 220;
const LOG_KEY = 'tatori_cam_log_v1';
const PARAMS = new URLSearchParams(location.search);
const SIM = PARAMS.has('sim');
// 実験用(MVP の既定では切ってある):?pose=1 で骨格検出、?pose=debug で関節の点も表示、&auto=1 で自動撮影
const POSE = PARAMS.has('pose');
const POSE_DEBUG = PARAMS.get('pose') === 'debug';
const AUTO = POSE && PARAMS.has('auto');
const MEDIAPIPE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const POSE_INTERVAL_MS = 100;
const PART_LABEL = { eye: '目', chest: '胸', waist: '腰', knee: '膝' };

const state = {
  templates: [],
  template: null,
  stream: null,
  tilt: null,          // {pitch, roll}。センサーがなければ null
  judge: null,
  up: null,            // ならした上向きベクトル
  handoffAt: 0,
  retakes: 0,
  shots: [],           // [{blob, url}]
  selected: 0,
  busy: false,
  wakeLock: null,
  pose: { landmarker: null, loading: null, ready: false, judge: null, subject: null, auto: null, timer: 0 },
};

// ---------- 画面の切り替え ----------
const SCREENS = ['picker', 'shoot', 'handback', 'result', 'log'];
function show(name) {
  for (const s of SCREENS) $(s).hidden = s !== name;
  window.scrollTo(0, 0);
}

// ---------- シルエット(試作用の汎用の人型。本番はお手本画像から作ったPNGに置き換える) ----------
// 右半身の輪郭。x は体の中心からの距離、y は頭頂=0・足先=1。単位はどちらも身長。
const HALF_OUTLINE = [
  [0, 0], [0.045, 0.02], [0.055, 0.065], [0.04, 0.115], [0.025, 0.135],
  [0.11, 0.165], [0.13, 0.21], [0.135, 0.32], [0.125, 0.44], [0.105, 0.5],
  [0.1, 0.56], [0.075, 0.72], [0.07, 0.82], [0.045, 0.95], [0.08, 0.99],
  [0.02, 1], [0.012, 0.94], [0.012, 0.74], [0, 0.54],
];

function silhouettePath(template, W, H) {
  const { top, height, x } = silhouetteLayout(template);
  const left = HALF_OUTLINE.slice(1, -1).reverse().map(([px, py]) => [-px, py]);
  const pts = [...HALF_OUTLINE, ...left].map(([px, py]) => [x * W + px * height * H, (top + py * height) * H]);
  // 閉じた Catmull-Rom 曲線をベジェに直す
  const n = pts.length;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + 'Z';
}

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

/** 点線シルエットと上下中央の線を描く。gauge=true なら傾きゲージも付ける */
function drawOverlay(svg, template, { gauge }) {
  const H = 1000;
  const W = Math.round(H * parseAspect(template.aspect));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const d = silhouettePath(template, W, H);
  el('path', { d, class: 'sil-shadow' }, svg);
  el('path', { d, class: 'sil' }, svg);
  el('line', { x1: 0, y1: H / 2, x2: W, y2: H / 2, class: 'centerline-shadow' }, svg);
  el('line', { x1: 0, y1: H / 2, x2: W, y2: H / 2, class: 'centerline' }, svg);
  if (!gauge) return null;
  const debug = el('g', { class: 'pose-debug' }, svg);
  const poseHint = el('g', { class: 'pose-hint' }, svg);
  const g = el('g', { class: 'gauge' }, svg);
  const level = el('g', {}, g);
  for (const cls of ['level-shadow', 'level']) {
    el('line', { x1: W / 2 - 170, y1: 0, x2: W / 2 - 50, y2: 0, class: cls }, level);
    el('line', { x1: W / 2 + 50, y1: 0, x2: W / 2 + 170, y2: 0, class: cls }, level);
  }
  // 指示は一度に1つ:回す向きの矢印、または線を中央へ戻す向きの山形
  const hint = el('path', { class: 'hint' }, g);
  return { level, hint, poseHint, debug, W, H };
}

const HINT_PATHS = {
  // 時計回り/反時計回りの円弧と矢じり
  rotate_cw: 'M-46,-18 A50,50 0 0 1 46,-18 L58,-36 L62,6 L22,-6 L38,-14 A38,38 0 0 0 -38,-14 Z',
  rotate_ccw: 'M46,-18 A50,50 0 0 0 -46,-18 L-58,-36 L-62,6 L-22,-6 L-38,-14 A38,38 0 0 1 38,-14 Z',
  up: 'M-34,14 L0,-22 L34,14 L22,24 L0,2 L-22,24 Z',
  down: 'M-34,-14 L0,22 L34,-14 L22,-24 L0,-2 L-22,-24 Z',
};

// 骨格の指示の絵。中心 (0,0)、大きさ約120
const ARROW_UP = 'M0,-60 L46,-8 L18,-8 L18,60 L-18,60 L-18,-8 L-46,-8 Z';
const CHEVRON = 'M-14,-24 L14,0 L-14,24 L-14,10 L-3,0 L-14,-10 Z';
const POSE_HINTS = {
  raise: [{ d: ARROW_UP, rot: 0 }],
  lower: [{ d: ARROW_UP, rot: 180 }],
  move_right: [{ d: ARROW_UP, rot: 90 }],
  move_left: [{ d: ARROW_UP, rot: -90 }],
  // 近づく=四隅へ広がる山形、下がる=中心へ縮む山形
  closer: [45, 135, 225, 315].map((a) => ({ d: CHEVRON, rot: a, r: 46 })),
  back: [45, 135, 225, 315].map((a) => ({ d: CHEVRON, rot: a + 180, r: -64 })),
};

let gaugeParts = null;
let shownPoseHint = '';

function render() {
  const shoot = $('shoot');
  if (!gaugeParts) return;
  const { level, hint, poseHint, debug, W, H } = gaugeParts;
  const t = state.template;
  const tiltKnown = !!state.tilt;
  const poseActive = POSE && state.pose.ready;
  shoot.dataset.sensor = tiltKnown ? 'on' : 'none';

  if (tiltKnown) {
    const j = (state.judge = judgeTilt(state.tilt, t, state.judge));
    shoot.dataset.tilt = String(j.ok);
    // 見やすいように実際の角度より大きく動かす。OKのときは中央に吸い付かせる
    const pitchErr = state.tilt.pitch - t.pitch.target_deg;
    const dy = j.pitchOk ? 0 : Math.max(-330, Math.min(330, pitchErr * 22));
    const rot = j.rollOk ? 0 : Math.max(-50, Math.min(50, state.tilt.roll * 3));
    level.setAttribute('transform', `translate(0 ${H / 2 + dy}) rotate(${rot} ${W / 2} 0)`);
    let path = '';
    let hy = H / 2 - 110;
    if (j.instruction === 'rotate_cw' || j.instruction === 'rotate_ccw') path = HINT_PATHS[j.instruction];
    else if (j.instruction === 'tilt_down') { path = HINT_PATHS.up; hy = H / 2 + dy - 60; }   // 線は下にある → 上へ戻す
    else if (j.instruction === 'tilt_up') { path = HINT_PATHS.down; hy = H / 2 + dy + 60; }
    hint.setAttribute('d', path);
    hint.setAttribute('transform', `translate(${W / 2} ${hy}) scale(1.5)`);
  } else {
    state.judge = null;
    shoot.dataset.tilt = 'false';
  }

  // 全体の判定:傾きが分かるなら傾き、骨格検出が動いていれば骨格も合っていること
  const poseJudge = poseActive ? state.pose.judge : null;
  let allOk = false;
  if (tiltKnown || poseActive) {
    allOk = (!tiltKnown || state.judge.ok) && (!poseActive || !!poseJudge?.ok);
  }
  shoot.dataset.ok = String(allOk);

  // 骨格の指示は、傾きが合ってから1つだけ出す
  const instruction = nextInstruction(tiltKnown ? state.judge : null, poseJudge);
  const key = POSE_HINTS[instruction] ? instruction : '';
  if (key !== shownPoseHint) {
    shownPoseHint = key;
    poseHint.replaceChildren();
    for (const part of POSE_HINTS[key] ?? []) {
      el('path', { d: part.d, class: 'hint', transform: `rotate(${part.rot}) translate(${part.r ?? 0} 0)` }, poseHint);
    }
  }
  poseHint.setAttribute('transform', `translate(${W / 2} ${H * 0.8}) scale(1.7)`);

  if (POSE_DEBUG) {
    debug.replaceChildren();
    for (const j of Object.values(state.pose.subject?.joints ?? {})) {
      if (j) el('circle', { cx: j.x * W, cy: j.y * H, r: 9, class: 'joint' }, debug);
    }
  }

  if (AUTO && poseActive && !state.busy) {
    state.pose.auto = updateAutoShoot(state.pose.auto, allOk, performance.now());
    if (state.pose.auto.fire) shoot_();
  }
}

// ---------- 骨格検出(実験用) ----------
async function loadPose() {
  const vision = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
  const make = (delegate) => vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 3,
  });
  try { return await make('GPU'); } catch { return await make('CPU'); }
}

const poseCanvas = document.createElement('canvas');

function detectPose() {
  const video = $('video');
  // 連写の間は検出を止める(撮影を遅らせないため)
  if (state.busy || $('shoot').hidden || !state.pose.landmarker || !video.videoWidth) return;
  // 画面に見えている範囲(切り出し後)だけを検出にかける。座標の変換が要らなくなる
  const aspect = parseAspect(state.template.aspect);
  const r = cropRect(video.videoWidth, video.videoHeight, aspect);
  poseCanvas.width = 384;
  poseCanvas.height = Math.round(384 / aspect);
  poseCanvas.getContext('2d').drawImage(video, r.x, r.y, r.w, r.h, 0, 0, poseCanvas.width, poseCanvas.height);
  let result;
  try { result = state.pose.landmarker.detectForVideo(poseCanvas, performance.now()); } catch (err) { console.warn(err); return; }
  const bodies = (result.landmarks ?? []).map((lm) => bodyFromMediaPipe(lm));
  const picked = pickSubject(bodies, state.template);
  state.pose.subject = picked ? bodies[picked.index] : null;
  state.pose.judge = judgePose(picked?.fit ?? null, state.template, state.pose.judge);
  state.pose.ready = true;
  render();
}

async function startPose() {
  if (!POSE) return;
  state.pose.judge = null;
  state.pose.auto = null;
  $('pose-badge').hidden = false;
  $('pose-badge').textContent = '骨格検出を準備中';
  try {
    state.pose.loading ??= loadPose();
    state.pose.landmarker = await state.pose.loading;
    $('pose-badge').textContent = AUTO ? '骨格検出・自動撮影(実験)' : '骨格検出(実験)';
    // 検出が遅い端末で処理がたまらないよう、1回終わってから次を予約する
    clearTimeout(state.pose.timer);
    const loop = () => {
      detectPose();
      state.pose.timer = setTimeout(loop, POSE_INTERVAL_MS);
    };
    loop();
  } catch (err) {
    state.pose.loading = null;
    $('pose-badge').textContent = '骨格検出を読み込めませんでした';
    console.warn(err);
  }
}

function stopPose() {
  clearTimeout(state.pose.timer);
  state.pose.ready = false;
}

// ---------- 傾きセンサー ----------
function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  const raw = upVector(e.beta, e.gamma);
  // 手ぶれをならす(上向きベクトルに一次の低域フィルタ)
  state.up = state.up ? state.up.map((v, i) => v + (raw[i] - v) * 0.25) : raw;
  const [ux, uy, uz] = state.up;
  const len = Math.hypot(ux, uy, uz) || 1;
  state.tilt = {
    pitch: Math.asin(Math.max(-1, Math.min(1, -uz / len))) * 180 / Math.PI,
    roll: Math.atan2(ux, uy) * 180 / Math.PI,
  };
  if (!$('shoot').hidden) render();
}

function simTilt() {
  // ?sim=1:センサーのないPCで、スライダーの値を端末の角度に見立てる
  state.tilt = tiltFromOrientation(90 + +$('sim-pitch').value, 0);
  state.tilt.roll = +$('sim-roll').value;
  render();
}

async function requestMotionPermission() {
  // iOS は、ボタンを押した直後に許可を求める必要がある
  const req = window.DeviceOrientationEvent?.requestPermission;
  if (typeof req !== 'function') return 'granted';
  try { return await req.call(window.DeviceOrientationEvent); } catch { return 'denied'; }
}

// ---------- カメラ ----------
async function startCamera() {
  if (state.stream) return;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
  });
  const video = $('video');
  video.srcObject = state.stream;
  await video.play().catch(() => {});
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  $('video').srcObject = null;
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
}

function captureFrame() {
  const video = $('video');
  const r = cropRect(video.videoWidth, video.videoHeight, parseAspect(state.template.aspect));
  const canvas = document.createElement('canvas');
  canvas.width = r.w;
  canvas.height = r.h;
  canvas.getContext('2d').drawImage(video, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/jpeg', 0.92));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ログ(端末内のみ) ----------
function readLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY)) ?? []; } catch { return []; }
}
function appendLog(entry) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify([...readLog(), entry])); } catch { /* 保存できなくても撮影は続ける */ }
}

// ---------- 1. お手本を選ぶ ----------
function renderTemplates() {
  const box = $('templates');
  box.replaceChildren();
  for (const t of state.templates) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tpl';
    b.id = `tpl-${t.id}`;
    b.setAttribute('aria-pressed', String(state.template?.id === t.id));
    const svg = document.createElementNS(SVG_NS, 'svg');
    drawOverlay(svg, t, { gauge: false });
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: t.name ?? t.id });
    const meta = Object.assign(document.createElement('span'), {
      className: 'meta',
      textContent: `中央の線=${PART_LABEL[t.center_line_part]}の高さ ・ ${t.owner_hint ?? ''}`,
    });
    b.append(svg, name, meta);
    b.addEventListener('click', () => {
      state.template = t;
      renderTemplates();
      $('start').disabled = false;
    });
    box.appendChild(b);
  }
}

function notice(text) {
  $('notice').textContent = text ?? '';
  $('notice').hidden = !text;
}

async function enterShoot() {
  state.judge = null;
  state.handoffAt = Date.now();
  $('frame').style.setProperty('--aspect', parseAspect(state.template.aspect));
  gaugeParts = drawOverlay($('overlay'), state.template, { gauge: true });
  for (const dot of $('dots').children) dot.classList.remove('done');
  $('shutter').disabled = false;
  $('sim').hidden = !SIM;
  show('shoot');
  if (SIM) simTilt(); else render();
  startPose();
  // センサーの値が来ない端末(PCなど)では、その旨を小さく出す
  setTimeout(() => { $('sensor-badge').hidden = !!state.tilt || $('shoot').hidden; }, 1500);
  try { state.wakeLock ??= await navigator.wakeLock?.request('screen'); } catch { /* なくてもよい */ }
}

$('start').addEventListener('click', async () => {
  if (!state.template || state.busy) return;
  state.busy = true;
  notice();
  try {
    const motion = requestMotionPermission();   // await の前に呼ぶ(iOS)
    await startCamera();
    if ((await motion) === 'granted') window.addEventListener('deviceorientation', onOrientation);
    state.retakes = 0;
    await enterShoot();
  } catch (err) {
    notice(err?.name === 'NotAllowedError'
      ? 'カメラが許可されていません。ブラウザの設定でこのページのカメラを許可してから、もう一度押してください。'
      : `カメラを開けませんでした(${err?.message ?? err})。`);
  } finally {
    state.busy = false;
  }
});

// ---------- 2. 撮影者モード ----------
$('shutter').addEventListener('click', () => shoot_(false));

async function shoot_(auto = true) {
  if (state.busy) return;
  state.busy = true;
  $('shutter').disabled = true;
  const tiltAtShutter = state.tilt && { ...state.tilt };
  const judgeAtShutter = state.judge;
  const poseAtShutter = POSE && state.pose.ready ? state.pose.judge : undefined;
  const shotAt = Date.now();
  for (const s of state.shots) URL.revokeObjectURL(s.url);
  state.shots = [];
  try {
    for (let i = 0; i < BURST_COUNT; i++) {
      const blob = await captureFrame();
      state.shots.push({ blob, url: URL.createObjectURL(blob) });
      $('dots').children[i].classList.add('done');
      const flash = $('flash');
      flash.classList.remove('on');
      void flash.offsetWidth;
      flash.classList.add('on');
      if (i < BURST_COUNT - 1) await sleep(BURST_INTERVAL_MS);
    }
    appendLog({
      at: new Date(shotAt).toISOString(),
      event: 'burst',
      template_id: state.template.id,
      pitch_deg: tiltAtShutter ? +tiltAtShutter.pitch.toFixed(1) : null,
      roll_deg: tiltAtShutter ? +tiltAtShutter.roll.toFixed(1) : null,
      tilt_ok: judgeAtShutter ? judgeAtShutter.ok : null,
      handoff_to_shot_sec: secondsBetween(state.handoffAt, shotAt),
      retake_count: state.retakes,
      ...(poseAtShutter !== undefined && {
        auto_shot: auto,
        pose_ok: poseAtShutter?.ok ?? null,
        pose_instruction: poseAtShutter?.instruction ?? null,
        pose_error: poseAtShutter?.error
          ? Object.fromEntries(Object.entries(poseAtShutter.error).map(([k, v]) => [k, +v.toFixed(3)]))
          : null,
      }),
    });
    stopPose();
    show('handback');
  } catch (err) {
    $('shutter').disabled = false;
    console.error(err);
  } finally {
    state.busy = false;
  }
}

// 鍵マークの長押しでオーナーの画面へ(誤タップでは抜けない)
{
  const lock = $('lock');
  let timer = 0;
  const cancel = () => { clearTimeout(timer); lock.classList.remove('holding'); };
  lock.addEventListener('pointerdown', () => {
    lock.classList.add('holding');
    timer = setTimeout(() => { cancel(); stopPose(); stopCamera(); show('picker'); }, 1200);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) lock.addEventListener(ev, cancel);
  $('shoot').addEventListener('contextmenu', (e) => e.preventDefault());
}

for (const id of ['sim-pitch', 'sim-roll']) $(id).addEventListener('input', simTilt);

// ---------- 3. 返してもらう → 4. 選んで保存 ----------
function renderResult() {
  $('preview').src = state.shots[state.selected].url;
  const box = $('thumbs');
  box.replaceChildren();
  state.shots.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = `thumb-${i}`;
    b.setAttribute('aria-pressed', String(i === state.selected));
    b.setAttribute('aria-label', `${i + 1}枚目`);
    const img = Object.assign(document.createElement('img'), { src: s.url, alt: '' });
    b.appendChild(img);
    b.addEventListener('click', () => { state.selected = i; renderResult(); });
    box.appendChild(b);
  });
}

$('to-result').addEventListener('click', () => {
  state.selected = 0;
  $('save-status').textContent = '';
  renderResult();
  show('result');
});

$('save').addEventListener('click', async () => {
  const shot = state.shots[state.selected];
  const name = `tatori-${state.template.id}-${Date.now()}.jpg`;
  const file = new File([shot.blob], name, { type: 'image/jpeg' });
  let how;
  try {
    if (navigator.canShare?.({ files: [file] })) {
      // iPhone:共有シートが開くので「画像を保存」を選ぶ
      await navigator.share({ files: [file] });
      how = 'share';
    } else {
      const a = Object.assign(document.createElement('a'), { href: shot.url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      how = 'download';
    }
  } catch (err) {
    if (err?.name === 'AbortError') { $('save-status').textContent = '保存をやめました。'; return; }
    $('save-status').textContent = `保存できませんでした(${err?.message ?? err})。`;
    return;
  }
  $('save-status').textContent = how === 'share' ? '共有シートに渡しました。' : 'ダウンロードしました。';
  appendLog({
    at: new Date().toISOString(), event: 'save', template_id: state.template.id,
    selected_index: state.selected, retake_count: state.retakes,
  });
});

$('retake').addEventListener('click', async () => {
  state.retakes += 1;
  await enterShoot();
});

$('back-to-picker').addEventListener('click', () => { stopCamera(); show('picker'); });

// ---------- ログ画面 ----------
function renderLog() {
  const log = readLog();
  $('log-body').textContent = log.length ? JSON.stringify(log, null, 2) : 'まだ記録がありません。1回撮ると、ここに出ます。';
  $('log-status').textContent = '';
}
$('open-log').addEventListener('click', () => { renderLog(); show('log'); });
$('close-log').addEventListener('click', () => show('picker'));
$('copy-log').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(readLog(), null, 2));
    $('log-status').textContent = 'コピーしました。';
  } catch {
    $('log-status').textContent = 'コピーできませんでした。上の文字を長押しして選んでください。';
  }
});
{
  // 確認は2回押し(confirm() に頼らない)
  let armed = false;
  $('clear-log').addEventListener('click', () => {
    if (!armed) {
      armed = true;
      $('clear-log').textContent = 'もう一度押すと消えます';
      setTimeout(() => { armed = false; $('clear-log').textContent = 'ログを消す'; }, 3000);
      return;
    }
    armed = false;
    try { localStorage.removeItem(LOG_KEY); } catch { /* 何もしない */ }
    $('clear-log').textContent = 'ログを消す';
    renderLog();
  });
}

// ---------- 起動 ----------
async function boot() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice('このページは https で開いてください。http のままではカメラを使えません。');
  }
  try {
    const res = await fetch('templates.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    state.templates = list.filter((t) => {
      const errors = validateTemplate(t);
      if (errors.length) console.warn(`テンプレ ${t.id} を除外:`, errors);
      return errors.length === 0;
    });
    renderTemplates();
  } catch (err) {
    notice(`お手本を読み込めませんでした(${err.message})。`);
  }
}
boot();
