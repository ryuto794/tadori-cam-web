// 判定ロジック(純粋関数のみ。DOM・カメラ・センサーに触れない)
// Swift 版の Logic/ に移すときの元になる。

const RAD = Math.PI / 180;

/** 全身シルエットの頭頂を 0、足先を 1 としたときの各部位の高さ */
export const PART_FRACTION = Object.freeze({
  eye: 0.06,
  chest: 0.26,
  waist: 0.42,
  knee: 0.72,
});

/**
 * deviceorientation の beta / gamma から、端末座標系での「世界の上向き」ベクトルを返す。
 * 端末座標系:x=画面の右、y=画面の上、z=画面から手前。
 * オイラー角をそのまま使うと端末を立てたとき(beta≈90°)に gamma が暴れるので、
 * 回転行列の3行目だけを使う。
 */
export function upVector(betaDeg, gammaDeg) {
  const b = betaDeg * RAD;
  const g = gammaDeg * RAD;
  return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
}

/**
 * 縦持ちの背面カメラの傾き(度)。
 * pitch:0=垂直。正=カメラが見上げている。
 * roll :0=水平。正=端末の上端が左に倒れている(時計回りに戻すと直る)。
 */
export function tiltFromOrientation(betaDeg, gammaDeg) {
  const [ux, uy, uz] = upVector(betaDeg, gammaDeg);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -uz))) / RAD;
  const roll = Math.atan2(ux, uy) / RAD;
  return { pitch, roll };
}

/** 一度OKになったら、許容+この幅を超えるまでOKのままにする(ちらつき防止) */
export const HYSTERESIS_DEG = 0.5;

/**
 * 傾きの判定。指示は一度に1つ、ロール → ピッチの順。
 * @param tilt {pitch, roll}
 * @param template テンプレ(pitch.target_deg / pitch.tol_deg / roll.tol_deg)
 * @param prev 前回の結果(ヒステリシス用。なければ省略)
 * @returns {rollOk, pitchOk, ok, instruction}
 *   instruction: 'rotate_cw' | 'rotate_ccw' | 'tilt_down' | 'tilt_up' | 'ok'
 */
export function judgeTilt(tilt, template, prev) {
  const rollTol = template.roll.tol_deg + (prev?.rollOk ? HYSTERESIS_DEG : 0);
  const pitchTol = template.pitch.tol_deg + (prev?.pitchOk ? HYSTERESIS_DEG : 0);
  const pitchErr = tilt.pitch - template.pitch.target_deg;
  const rollOk = Math.abs(tilt.roll) <= rollTol;
  const pitchOk = Math.abs(pitchErr) <= pitchTol;
  let instruction = 'ok';
  if (!rollOk) instruction = tilt.roll > 0 ? 'rotate_cw' : 'rotate_ccw';
  else if (!pitchOk) instruction = pitchErr > 0 ? 'tilt_down' : 'tilt_up';
  return { rollOk, pitchOk, ok: rollOk && pitchOk, instruction };
}

/** "4:5" → 0.8(幅÷高さ) */
export function parseAspect(aspect) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect ?? '');
  if (!m || +m[1] <= 0 || +m[2] <= 0) throw new Error(`aspect が不正です: ${aspect}`);
  return +m[1] / +m[2];
}

/** 映像の中央から、指定の縦横比で切り出す範囲(ピクセル) */
export function cropRect(videoW, videoH, aspect) {
  let w = videoW;
  let h = Math.round(videoW / aspect);
  if (h > videoH) {
    h = videoH;
    w = Math.round(videoH * aspect);
  }
  return { x: Math.round((videoW - w) / 2), y: Math.round((videoH - h) / 2), w, h };
}

/**
 * 点線シルエット(全身)を画面のどこに置くか。単位は画面の高さ=1。
 * ピッチ0°では「上下中央の線に来る部位=カメラの高さ」なので、
 * 頭の位置(anchor)と中央線の部位から、全身の大きさが一意に決まる。
 * @returns {top, height, x}  top:頭頂のy、height:全身の高さ、x:中心のx(画面の幅=1)
 */
export function silhouetteLayout(template) {
  const part = PART_FRACTION[template.center_line_part];
  if (part === undefined) throw new Error(`center_line_part が不正です: ${template.center_line_part}`);
  if (template.anchor?.part !== 'head') throw new Error('anchor.part は head のみ対応しています');
  const top = template.anchor.y_from_top;
  if (!(top >= 0 && top < 0.5)) throw new Error('anchor.y_from_top は 0 以上 0.5 未満にしてください');
  return { top, height: (0.5 - top) / part, x: template.subject_x ?? 0.5 };
}

/** テンプレの検査。問題点の文字列の配列を返す(空なら問題なし) */
export function validateTemplate(t) {
  const errors = [];
  if (!t.id) errors.push('id がありません');
  try { parseAspect(t.aspect); } catch (e) { errors.push(e.message); }
  if (!(t.pitch?.tol_deg > 0)) errors.push('pitch.tol_deg は正の数にしてください');
  if (typeof t.pitch?.target_deg !== 'number') errors.push('pitch.target_deg がありません');
  if (!(t.roll?.tol_deg > 0)) errors.push('roll.tol_deg は正の数にしてください');
  try { silhouetteLayout(t); } catch (e) { errors.push(e.message); }
  return errors;
}

/** 手渡しから撮影までの秒数(小数1桁) */
export function secondsBetween(startMs, endMs) {
  return Math.round((endMs - startMs) / 100) / 10;
}
