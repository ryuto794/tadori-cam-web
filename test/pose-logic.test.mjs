import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOINT_FRACTION, fitBody, expectedBody, pickSubject, judgePose,
  nextInstruction, updateAutoShoot, bodyFromMediaPipe, poseSupported,
} from '../pose-logic.js';

const tpl = {
  id: 't', aspect: '4:5',
  pitch: { target_deg: 0, tol_deg: 2 }, roll: { tol_deg: 1 },
  center_line_part: 'waist', anchor: { part: 'head', y_from_top: 0.15 }, subject_x: 0.5,
  subject_size: { target: 0.83, tol: 0.05 },
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** 頭頂 top・全身の高さ height・中心 cx の人物の関節を作る。画面の外の関節は見えない扱い */
function bodyAt({ top, height, cx }, { clip = true } = {}) {
  const joints = {};
  for (const [name, f] of Object.entries(JOINT_FRACTION)) {
    const y = top + f * height;
    joints[name] = clip && y > 1 ? null : { x: cx, y };
  }
  return { joints };
}
const want = expectedBody(tpl);
const onTarget = { top: want.top, height: want.height, cx: want.centerX };

test('関節の位置から、頭頂と全身の高さを復元できる', () => {
  const fit = fitBody(bodyAt({ top: 0.2, height: 0.6, cx: 0.4 }));
  near(fit.top, 0.2); near(fit.height, 0.6); near(fit.centerX, 0.4);
  assert.equal(fit.used, 5);
});

test('足が画面の外でも(膝上)、見えている関節だけで全身の大きさを推定する', () => {
  const fit = fitBody(bodyAt({ top: 0.12, height: 1.46, cx: 0.5 }));
  assert.equal(fit.used, 3);          // 目・肩・腰だけ
  near(fit.height, 1.46); near(fit.top, 0.12);
});

test('関節が足りなければ判定しない', () => {
  assert.equal(fitBody({ joints: { eye: { x: 0.5, y: 0.2 } } }), null);
  assert.equal(fitBody({ joints: {} }), null);
  assert.equal(fitBody(null), null);
  // 肩も腰も見えないと左右の位置が決まらない
  assert.equal(fitBody({ joints: { eye: { x: 0.5, y: 0.2 }, knee: { x: 0.5, y: 0.7 } } }), null);
});

test('点線どおりなら ok', () => {
  const j = judgePose(fitBody(bodyAt(onTarget)), tpl);
  assert.equal(j.ok, true);
  assert.equal(j.instruction, 'ok');
});

test('誰も写っていなければ no_subject', () => {
  assert.equal(judgePose(null, tpl).instruction, 'no_subject');
});

test('カメラが高すぎる(中央線が胸を通る)→ 下げる。低すぎる → 上げる', () => {
  // 同じ大きさのまま、人物が画面の下にずれる=中央線は体の上のほうを通る=カメラが高い
  const high = fitBody(bodyAt({ ...onTarget, top: onTarget.top + 0.1 }, { clip: false }));
  assert.equal(judgePose(high, tpl).instruction, 'lower');
  const low = fitBody(bodyAt({ ...onTarget, top: onTarget.top - 0.1 }));
  assert.equal(judgePose(low, tpl).instruction, 'raise');
});

test('高さが合っていて人物が小さい → 近づく。大きい → 下がる', () => {
  // 中央線が腰を通るまま、大きさだけ変える
  const scaled = (k) => {
    const height = want.height * k;
    return fitBody(bodyAt({ top: 0.5 - 0.42 * height, height, cx: 0.5 }, { clip: false }));
  };
  assert.equal(judgePose(scaled(0.8), tpl).instruction, 'closer');
  assert.equal(judgePose(scaled(1.2), tpl).instruction, 'back');
  assert.equal(judgePose(scaled(1.03), tpl).instruction, 'ok');
});

test('人が右に寄っている → カメラを右へ。左なら左へ', () => {
  assert.equal(judgePose(fitBody(bodyAt({ ...onTarget, cx: 0.62 })), tpl).instruction, 'move_right');
  assert.equal(judgePose(fitBody(bodyAt({ ...onTarget, cx: 0.38 })), tpl).instruction, 'move_left');
});

test('指示は一度に1つ。高さ → 距離 → 位置の順', () => {
  const all = fitBody(bodyAt({ top: 0.4, height: want.height * 0.7, cx: 0.7 }, { clip: false }));
  const j = judgePose(all, tpl);
  assert.equal(j.instruction, 'lower');
  assert.equal(j.sizeOk, false);
  assert.equal(j.xOk, false);
});

test('ヒステリシス:合ったあとは許容が1.3倍になる', () => {
  const ok = judgePose(fitBody(bodyAt(onTarget)), tpl);
  const slightlyOff = fitBody(bodyAt({ ...onTarget, cx: 0.56 }));
  assert.equal(judgePose(slightlyOff, tpl).xOk, false);
  assert.equal(judgePose(slightlyOff, tpl, ok).xOk, true);
  assert.equal(judgePose(fitBody(bodyAt({ ...onTarget, cx: 0.58 })), tpl, ok).xOk, false);
});

test('傾きが先。傾きが合ってから骨格の指示を出す', () => {
  const pose = judgePose(fitBody(bodyAt({ ...onTarget, cx: 0.7 })), tpl);
  assert.equal(nextInstruction({ ok: false, instruction: 'rotate_cw' }, pose), 'rotate_cw');
  assert.equal(nextInstruction({ ok: true, instruction: 'ok' }, pose), 'move_right');
  assert.equal(nextInstruction(null, pose), 'move_right');   // 傾きセンサーなし
  assert.equal(nextInstruction({ ok: true, instruction: 'ok' }, null), 'ok');
});

test('混んだ背景:点線にいちばん近い人を被写体にする', () => {
  const bodies = [
    bodyAt({ top: 0.35, height: 0.3, cx: 0.15 }),    // 奥の客
    bodyAt({ ...onTarget, cx: 0.53 }),               // 本人
    bodyAt({ top: 0.3, height: 0.4, cx: 0.85 }),     // 別の客
  ];
  assert.equal(pickSubject(bodies, tpl).index, 1);
  assert.equal(pickSubject([], tpl), null);
  assert.equal(pickSubject([{ joints: {} }], tpl), null);
});

test('自動撮影:合った状態が0.5秒続いたら1回だけ撃つ', () => {
  let s = updateAutoShoot(undefined, true, 1000);
  assert.equal(s.fire, false);
  s = updateAutoShoot(s, true, 1300);
  assert.equal(s.fire, false);
  s = updateAutoShoot(s, true, 1500);
  assert.equal(s.fire, true);
  s = updateAutoShoot(s, true, 1700);
  assert.equal(s.fire, false);          // 2回目は撃たない
  s = updateAutoShoot(s, false, 1800);  // 外れたらやり直し
  s = updateAutoShoot(s, true, 1900);
  s = updateAutoShoot(s, true, 2300);
  assert.equal(s.fire, false);
  s = updateAutoShoot(s, true, 2400);
  assert.equal(s.fire, true);
});

test('座りのテンプレは骨格で判定しない', () => {
  assert.equal(poseSupported(tpl), true);
  assert.equal(poseSupported({ ...tpl, pose: 'seated' }), false);
});

test('MediaPipe の33点から関節を取り出す', () => {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const set = (i, x, y, visibility = 0.9) => { lm[i] = { x, y, visibility }; };
  set(2, 0.52, 0.2); set(5, 0.48, 0.2);
  set(11, 0.6, 0.3); set(12, 0.4, 0.3);
  set(23, 0.56, 0.55); set(24, 0.44, 0.55, 0.2);   // 右腰は隠れている
  set(25, 0.55, 0.8); set(26, 0.45, 0.8);
  set(27, 0.55, 1.2); set(28, 0.45, 1.2);          // 足首は画面の外
  const body = bodyFromMediaPipe(lm);
  near(body.joints.eye.x, 0.5); near(body.joints.shoulder.y, 0.3);
  near(body.joints.hip.x, 0.56);
  assert.equal(body.joints.ankle, null);
  assert.ok(fitBody(body));
});
