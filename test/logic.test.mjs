import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tiltFromOrientation, judgeTilt, parseAspect, cropRect,
  silhouetteLayout, validateTemplate, secondsBetween, PART_FRACTION,
} from '../logic.js';
import { readFileSync } from 'node:fs';

const tpl = {
  id: 't', aspect: '4:5',
  pitch: { target_deg: 0, tol_deg: 2 }, roll: { tol_deg: 1 },
  center_line_part: 'chest', anchor: { part: 'head', y_from_top: 0.12 }, subject_x: 0.5,
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('垂直に立てるとピッチもロールも0', () => {
  const t = tiltFromOrientation(90, 0);
  near(t.pitch, 0); near(t.roll, 0);
});

test('上端を手前に倒す(beta>90)と見上げ=ピッチ正、奥に倒すと負', () => {
  near(tiltFromOrientation(100, 0).pitch, 10);
  near(tiltFromOrientation(80, 0).pitch, -10);
});

test('平置き(画面が上)はカメラが真下=ピッチ-90', () => {
  near(tiltFromOrientation(0, 0).pitch, -90);
});

test('立てた状態に近くてもロールが安定して求まる', () => {
  // beta=85°, gamma=30° → 上向きベクトルから計算した値と一致し、gamma そのものにはならない
  const t = tiltFromOrientation(85, 30);
  const expected = Math.atan2(-Math.cos(85 * Math.PI / 180) * Math.sin(30 * Math.PI / 180), Math.sin(85 * Math.PI / 180)) * 180 / Math.PI;
  near(t.roll, expected);
  assert.ok(Math.abs(t.roll) < 3);
});

test('ロールの符号は左右で反転する', () => {
  const a = tiltFromOrientation(60, 20).roll;
  const b = tiltFromOrientation(60, -20).roll;
  assert.ok(a < 0 && b > 0);
  near(a, -b);
});

test('指示は一度に1つ。ロールが先、次にピッチ', () => {
  assert.equal(judgeTilt({ pitch: 10, roll: 5 }, tpl).instruction, 'rotate_cw');
  assert.equal(judgeTilt({ pitch: 10, roll: -5 }, tpl).instruction, 'rotate_ccw');
  assert.equal(judgeTilt({ pitch: 10, roll: 0.5 }, tpl).instruction, 'tilt_down');
  assert.equal(judgeTilt({ pitch: -10, roll: 0.5 }, tpl).instruction, 'tilt_up');
  const ok = judgeTilt({ pitch: 1.9, roll: -0.9 }, tpl);
  assert.equal(ok.instruction, 'ok');
  assert.equal(ok.ok, true);
});

test('許容値はテンプレごと。target_deg からのズレで判定する', () => {
  const up = { ...tpl, pitch: { target_deg: 10, tol_deg: 3 } };
  assert.equal(judgeTilt({ pitch: 12, roll: 0 }, up).ok, true);
  assert.equal(judgeTilt({ pitch: 0, roll: 0 }, up).instruction, 'tilt_up');
});

test('ヒステリシス:OKのあとは許容+0.5°まではOKのまま', () => {
  const first = judgeTilt({ pitch: 0, roll: 1.3 }, tpl);
  assert.equal(first.rollOk, false);
  const wasOk = judgeTilt({ pitch: 0, roll: 0.5 }, tpl);
  assert.equal(judgeTilt({ pitch: 0, roll: 1.3 }, tpl, wasOk).rollOk, true);
  assert.equal(judgeTilt({ pitch: 0, roll: 1.6 }, tpl, wasOk).rollOk, false);
  assert.equal(judgeTilt({ pitch: 2.4, roll: 0 }, tpl, wasOk).pitchOk, true);
  assert.equal(judgeTilt({ pitch: 2.6, roll: 0 }, tpl, wasOk).pitchOk, false);
});

test('縦横比の読み取り', () => {
  near(parseAspect('4:5'), 0.8);
  near(parseAspect('3:4'), 0.75);
  assert.throws(() => parseAspect('abc'));
  assert.throws(() => parseAspect('0:5'));
});

test('中央から 4:5 で切り出す', () => {
  assert.deepEqual(cropRect(1440, 1920, 0.8), { x: 0, y: 60, w: 1440, h: 1800 });
  // 横長の映像(PCのカメラ)では左右を切る
  assert.deepEqual(cropRect(1280, 720, 0.8), { x: 352, y: 0, w: 576, h: 720 });
});

test('シルエットは、指定の部位が上下中央の線に来る大きさになる', () => {
  for (const part of Object.keys(PART_FRACTION)) {
    const l = silhouetteLayout({ ...tpl, center_line_part: part });
    near(l.top + l.height * PART_FRACTION[part], 0.5);
    near(l.top, 0.12);
  }
});

test('テンプレの検査', () => {
  assert.deepEqual(validateTemplate(tpl), []);
  assert.ok(validateTemplate({ ...tpl, center_line_part: 'elbow' }).length > 0);
  assert.ok(validateTemplate({ ...tpl, roll: { tol_deg: 0 } }).length > 0);
  assert.ok(validateTemplate({ ...tpl, id: '' }).length > 0);
});

test('同梱のテンプレはすべて検査を通る', () => {
  const list = JSON.parse(readFileSync(new URL('../templates.json', import.meta.url), 'utf8'));
  assert.ok(list.length >= 2);
  for (const t of list) assert.deepEqual(validateTemplate(t), [], t.id);
  assert.equal(new Set(list.map((t) => t.id)).size, list.length);
});

test('手渡しから撮影までの秒数', () => {
  assert.equal(secondsBetween(1000, 13_460), 12.5);
});
