// 骨格検出を使った判定(次の段階の準備。MVP の既定では使わない)
// 純粋関数のみ。検出器(MediaPipe / Apple Vision)に依存しない形で受け取る。
//
// 座標はすべて「切り出した画面」基準:x は左=0・右=1、y は上=0・下=1。

import { PART_FRACTION, silhouetteLayout } from './logic.js';

/** 頭頂=0・足先=1 としたときの関節の高さ(標準的な体型の近似。実写で要調整) */
export const JOINT_FRACTION = Object.freeze({
  eye: 0.06,
  shoulder: 0.18,
  hip: 0.48,
  knee: 0.72,
  ankle: 0.95,
});

/** 許容。テンプレに値がないときの既定 */
export const POSE_TOLERANCE = Object.freeze({
  height: 0.05,      // 中央線に来る部位のずれ(身長に対する割合。160cm で約8cm)
  x: 0.05,           // 左右のずれ(画面の幅に対する割合)
  hysteresis: 1.3,   // いったん合ったら、許容をこの倍率まで広げる
});

/**
 * 見えている関節の y から、人物の「頭頂の位置」と「全身の高さ」を当てはめる(最小二乗)。
 * 足が画面の外でも、2つ以上の高さの違う関節が見えていれば全身の大きさを推定できる。
 * @param body {joints: {eye|shoulder|hip|knee|ankle: {x, y} | null}}
 * @returns {top, height, centerX, used} | null
 */
export function fitBody(body) {
  const pts = [];
  for (const [name, frac] of Object.entries(JOINT_FRACTION)) {
    const j = body?.joints?.[name];
    if (j && Number.isFinite(j.y)) pts.push({ f: frac, y: j.y });
  }
  if (pts.length < 2) return null;
  const n = pts.length;
  const mf = pts.reduce((s, p) => s + p.f, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  const sff = pts.reduce((s, p) => s + (p.f - mf) ** 2, 0);
  if (sff < 1e-6) return null;
  const height = pts.reduce((s, p) => s + (p.f - mf) * (p.y - my), 0) / sff;
  if (!(height > 0.05)) return null;   // 逆さま、または小さすぎる
  const xs = ['shoulder', 'hip'].map((k) => body.joints[k]?.x).filter(Number.isFinite);
  if (!xs.length) return null;
  return {
    top: my - mf * height,
    height,
    centerX: xs.reduce((s, v) => s + v, 0) / xs.length,
    used: n,
  };
}

/** テンプレが求める人物の位置(fitBody と同じ形) */
export function expectedBody(template) {
  const { top, height, x } = silhouetteLayout(template);
  return { top, height, centerX: x };
}

/**
 * 複数の人が写っているとき、点線の位置にいちばん近い人を被写体として選ぶ。
 * @returns {index, fit} | null
 */
export function pickSubject(bodies, template) {
  const want = expectedBody(template);
  const wantY = want.top + want.height * 0.33;   // 胴のあたり
  let best = null;
  bodies.forEach((body, index) => {
    const fit = fitBody(body);
    if (!fit) return;
    const d = Math.hypot(fit.centerX - want.centerX, fit.top + fit.height * 0.33 - wantY)
      + Math.abs(Math.log(fit.height / want.height)) * 0.3;
    if (!best || d < best.d) best = { index, fit, d };
  });
  return best && { index: best.index, fit: best.fit };
}

/**
 * 点線とのずれを判定する。指示は一度に1つ、高さ → 距離 → 位置の順。
 * @param fit fitBody の結果(null なら被写体なし)
 * @param prev 前回の結果(ヒステリシス用)
 * @returns {heightOk, sizeOk, xOk, ok, instruction, error}
 *   instruction: 'no_subject' | 'lower' | 'raise' | 'closer' | 'back' | 'move_left' | 'move_right' | 'ok'
 *   lower=カメラを下げる(しゃがむ)、raise=カメラを上げる(立つ)
 */
export function judgePose(fit, template, prev) {
  if (!fit) {
    return { heightOk: false, sizeOk: false, xOk: false, ok: false, instruction: 'no_subject', error: null };
  }
  const want = expectedBody(template);
  const wide = (wasOk) => (wasOk ? POSE_TOLERANCE.hysteresis : 1);

  // 高さ:ピッチ0°では、上下中央の線に写る部位がカメラの高さ。
  // 中央線が体のどこを通っているか(頭頂=0、足先=1)を、テンプレの指定と比べる
  const atCenter = (0.5 - fit.top) / fit.height;
  const heightErr = atCenter - PART_FRACTION[template.center_line_part];   // 正=カメラが低すぎる
  const heightOk = Math.abs(heightErr) <= POSE_TOLERANCE.height * wide(prev?.heightOk);

  // 距離:全身の大きさの比
  const sizeTol = (template.subject_size?.tol ?? 0.05) / (template.subject_size?.target ?? 0.7);
  const sizeErr = fit.height / want.height - 1;                             // 正=近すぎる
  const sizeOk = Math.abs(sizeErr) <= sizeTol * wide(prev?.sizeOk);

  // 位置:左右
  const xErr = fit.centerX - want.centerX;                                  // 正=人が右に寄っている
  const xOk = Math.abs(xErr) <= POSE_TOLERANCE.x * wide(prev?.xOk);

  let instruction = 'ok';
  if (!heightOk) instruction = heightErr > 0 ? 'raise' : 'lower';
  else if (!sizeOk) instruction = sizeErr > 0 ? 'back' : 'closer';
  else if (!xOk) instruction = xErr > 0 ? 'move_right' : 'move_left';
  return {
    heightOk, sizeOk, xOk, ok: heightOk && sizeOk && xOk, instruction,
    error: { height: heightErr, size: sizeErr, x: xErr },
  };
}

/** 傾き → 骨格の順で、出す指示を1つに決める */
export function nextInstruction(tiltJudge, poseJudge) {
  if (tiltJudge && !tiltJudge.ok) return tiltJudge.instruction;
  if (poseJudge) return poseJudge.instruction;
  return 'ok';
}

/**
 * 自動撮影:すべて合った状態が holdMs 続いたら fire=true を1回だけ返す。
 * @param state {since: number|null, fired: boolean}(最初は省略可)
 */
export function updateAutoShoot(state, allOk, nowMs, holdMs = 500) {
  if (!allOk) return { since: null, fired: false, fire: false };
  const since = state?.since ?? nowMs;
  const fired = state?.fired ?? false;
  const fire = !fired && nowMs - since >= holdMs;
  return { since, fired: fired || fire, fire };
}

/**
 * MediaPipe Pose の33点を、検出器に依存しない形に直す。
 * 左右の両方が見えていれば平均、片方だけならそれを使う。
 */
export function bodyFromMediaPipe(landmarks, minVisibility = 0.5) {
  const pick = (a, b) => {
    const ok = [landmarks[a], landmarks[b]].filter((p) => p && (p.visibility ?? 1) >= minVisibility
      && p.y >= -0.02 && p.y <= 1.02);
    if (!ok.length) return null;
    return { x: ok.reduce((s, p) => s + p.x, 0) / ok.length, y: ok.reduce((s, p) => s + p.y, 0) / ok.length };
  };
  return {
    joints: {
      eye: pick(2, 5),
      shoulder: pick(11, 12),
      hip: pick(23, 24),
      knee: pick(25, 26),
      ankle: pick(27, 28),
    },
  };
}
