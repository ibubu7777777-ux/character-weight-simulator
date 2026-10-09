import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { loadFigure } from "./figure.js?v=20261010-6";
import { calculate, clamp, PRESETS, RANGES } from "./body.js?v=20261010-6";

const IDS = ["A", "B"];
const DEFAULT_NAMES = { A: "キャラクターA", B: "キャラクターB" };
const GENDER_LABEL = { male: "男性", female: "女性" };
const FIGURE_COLOR = { A: 0xf6c9d4, B: 0xf5e29d }; // A: 淡い桃色、B: 淡い黄色（3Dの人体の色。画面の小さな印は、style.css の --a / --b で、これより少し濃い）

const STORAGE_KEY = "character-weight-simulator.v1";

const defaults = () => ({
  A: { name: DEFAULT_NAMES.A, gender: "male", height: 172, muscle: 50, bodyFat: 18, weight: null, bust: 50 },
  B: { name: DEFAULT_NAMES.B, gender: "female", height: 158, muscle: 50, bodyFat: 27, weight: null, bust: 50 },
});
const esc = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const displayName = (id) => state[id].name.trim() || DEFAULT_NAMES[id];

// ---------- 状態の保存・復元 ----------
function sanitize(raw, fallback) {
  const gender = raw?.gender === "female" ? "female" : raw?.gender === "male" ? "male" : fallback.gender;
  const r = RANGES[gender];
  const num = (v, fb) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fb);
  const name = typeof raw?.name === "string" ? raw.name.slice(0, 20) : fallback.name;
  return {
    name,
    gender,
    height: clamp(Math.round(num(raw?.height, fallback.height)), ...r.height),
    muscle: clamp(Math.round(num(raw?.muscle, fallback.muscle)), ...r.muscle),
    bodyFat: clamp(num(raw?.bodyFat, fallback.bodyFat), ...r.bodyFat),
    weight: null,
    bust: clamp(Math.round(num(raw?.bust, fallback.bust ?? 50)), 0, 100),
  };
}

function fromHash() {
  const out = {};
  for (const part of location.hash.replace(/^#/, "").split("&")) {
    const [id, value] = part.split("=");
    if (!IDS.includes(id) || !value) continue;
    const [gender, height, muscle, bodyFat, name, bust] = value.split(",");
    let decoded;
    try {
      decoded = name === undefined ? undefined : decodeURIComponent(name);
    } catch {
      decoded = undefined; // 壊れたURLでも名前以外は復元する
    }
    out[id] = { gender, height, muscle, bodyFat, name: decoded, bust };
  }
  return Object.keys(out).length ? out : null;
}

function loadState() {
  const base = defaults();
  let source = fromHash();
  if (!source) {
    try {
      source = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    } catch {
      source = null;
    }
  }
  const state = {};
  for (const id of IDS) state[id] = sanitize(source?.[id], base[id]);
  return state;
}

function hashOf(state) {
  return IDS.map((id) => {
    const s = state[id];
    return `${id}=${s.gender},${s.height},${s.muscle},${s.bodyFat.toFixed(1)},${encodeURIComponent(s.name)},${s.bust}`;
  }).join("&");
}

function persist() {
  scheduleHistoryCommit();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 保存できない環境でも動作に支障なし */
  }
  try {
    history.replaceState(null, "", "#" + hashOf(state));
  } catch {
    /* file:// などで失敗しても無視 */
  }
}

const state = loadState();
const results = {};
const panels = {};

// ---------- 3D シーン ----------
const view = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 淡い色が、陰影で暗くくすまないよう、全体を明るく照らし、陰影はやわらかくする
scene.add(new THREE.HemisphereLight(0xffffff, 0xc4ccd8, 2.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(2, 4, 3);
scene.add(sun);

// 平行投影のカメラ。奥行きによる大きさの違いが出ないので、奥に置いた目盛りや目線のラインでも
// 身長を正しく読み取れる（二人の立ち位置がずれても、身長差が変わらない）。
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = true; // 右ドラッグ / Shift+ドラッグ / 2本指ドラッグで、表示する範囲を上下左右に動かす
controls.screenSpacePanning = true;
// 1本指は回転。2本指は、下の独自の処理（移動を基本に、つまんだときだけ拡大縮小）で扱う
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: null };
controls.minZoom = 0.6;
controls.maxZoom = 4;
controls.maxPolarAngle = Math.PI / 2; // 水平より下（下からの煽り）には回らない。上へのドラッグで水平 0 度で止まる

const CAMERA_DISTANCE = 12;
const TARGET_Y = 0.95;

// 舞台の拡大率。身長が 220cm を超えるキャラクターがいるときは、カメラの範囲・目盛り・立ち位置・文字を
// まとめて大きくして、全身が収まるようにする（220cm 以下では 1）。
let stageScale = 1;
const targetY = () => TARGET_Y * stageScale;
const VIEWS = {
  front: () => [0, targetY(), CAMERA_DISTANCE], // カメラの高さを注視点と同じにして、ちょうど水平から見る
  side: () => [CAMERA_DISTANCE, targetY(), 0],
};
let viewName = "front";

// 正面: 二人を左右(x)に並べる。横: カメラが横(x方向)から見るので、二人を奥行き(z)に並べて
// 画面上で左右に並ぶようにし、向かい合わせにする（A が画面左、B が画面右）。
const SPACING = 0.55;
function orientFigures() {
  const side = viewName === "side";
  decor.rotation.y = side ? Math.PI / 2 : 0;
  for (const id of IDS) if (figures[id]) figures[id].group.rotation.y = side && id === "A" ? Math.PI : 0;
}
function layoutFigures() {
  orientFigures();
  for (const id of IDS) {
    const figure = figures[id];
    if (!figure) continue;
    const sign = id === "A" ? 1 : -1; // A が画面左
    const d = SPACING * stageScale;
    if (viewName === "side") figure.group.position.set(0, 0, sign * d);
    else figure.group.position.set(-sign * d, 0, 0);
  }
  updateEyeLink();
  requestRender();
}

function syncViewButtons() {
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === viewName));
}

function setView(name) {
  viewName = name;
  layoutFigures(); // 視点を切り替えると、ドラッグで動かした立ち位置も初期位置に戻る
  resetCamera();
  syncViewButtons();
  scheduleHistoryCommit();
  requestRender();
}

// 一番高いキャラクターに合わせて舞台の拡大率を決め、変わったときだけ作り直す
function applyStageScale() {
  const tallest = Math.max(state.A.height, state.B.height) / 100;
  const next = Math.max(1, tallest / 2.2);
  if (Math.abs(next - stageScale) < 1e-6) return;
  const shift = (next - stageScale) * TARGET_Y;
  stageScale = next;
  camera.position.y += shift; // 見ている向きは変えずに、高さだけ合わせる
  controls.target.y += shift;
  controls.update();
  buildDecor();
  resize();
  layoutFigures();
}

// 表示範囲を動かしすぎて、人体が見えなくならないように範囲を制限する（動かした分だけカメラも戻す）
function clampPan() {
  const t = controls.target;
  const limit = 3 * stageScale;
  const clamped = new THREE.Vector3(
    clamp(t.x, -limit, limit),
    clamp(t.y, 0, 3.6 * stageScale),
    clamp(t.z, -limit, limit)
  );
  const delta = clamped.sub(t);
  if (delta.lengthSq() > 0) {
    t.add(delta);
    camera.position.add(delta);
  }
}

// 拡大・移動・回転をやり直して、今の「正面」「横」の標準の見え方に戻す（人体の立ち位置は変えない）
function resetCamera() {
  camera.position.set(...VIEWS[viewName]());
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  controls.target.set(0, targetY(), 0);
  controls.update();
  requestRender();
}

// ---------- スマホ（タッチ）の操作 ----------
// 2本指のドラッグは、表示位置の移動。指の間隔が大きく変わったとき（つまむ・広げる）だけ、拡大縮小も行う。
// 移動しているつもりで、指の間隔が少し変わっただけでは、拡大縮小にならない。
const touchPointers = new Map();
let pinch = null;
const movedSinceUpdate = new Set(); // 指ごとに動きの通知が別々に届くので、両方の指が動いてから判定する
const PINCH_START_RATIO = 0.12; // 指の間隔が、この割合（対数）以上変わったら拡大縮小を始める
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

function panByPixels(dx, dy) {
  const perX = (camera.right - camera.left) / camera.zoom / view.clientWidth;
  const perY = (camera.top - camera.bottom) / camera.zoom / view.clientHeight;
  _right.setFromMatrixColumn(camera.matrixWorld, 0);
  _up.setFromMatrixColumn(camera.matrixWorld, 1);
  const offset = _right.multiplyScalar(-dx * perX).addScaledVector(_up, dy * perY);
  controls.target.add(offset);
  camera.position.add(offset);
  clampPan();
}

function zoomBy(factor) {
  camera.zoom = clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom);
  camera.updateProjectionMatrix();
  requestRender();
}

const touchMetrics = () => {
  const [a, b] = [...touchPointers.values()];
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
};

view.addEventListener(
  "pointerdown",
  (event) => {
    if (event.pointerType !== "touch") return;
    touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    movedSinceUpdate.clear();
    if (touchPointers.size === 2) pinch = { ...touchMetrics(), base: touchMetrics().dist, zooming: false };
  },
  true
);
view.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "touch" || !touchPointers.has(event.pointerId)) return;
  touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (touchPointers.size !== 2 || !pinch) return;
  movedSinceUpdate.add(event.pointerId);
  if (movedSinceUpdate.size < 2) return;
  movedSinceUpdate.clear();
  const now = touchMetrics();
  panByPixels(now.mid.x - pinch.mid.x, now.mid.y - pinch.mid.y);
  if (!pinch.zooming && Math.abs(Math.log(now.dist / pinch.base)) > PINCH_START_RATIO) pinch.zooming = true;
  if (pinch.zooming) zoomBy(now.dist / pinch.dist);
  pinch.mid = now.mid;
  pinch.dist = now.dist;
  requestRender();
});
const endTouch = (event) => {
  if (event.pointerType !== "touch") return;
  touchPointers.delete(event.pointerId);
  movedSinceUpdate.clear();
  if (touchPointers.size < 2) pinch = null;
};
view.addEventListener("pointerup", endTouch);
view.addEventListener("pointercancel", endTouch);
const resetTouches = (event) => {
  if (event.touches.length > 0) return;
  touchPointers.clear();
  movedSinceUpdate.clear();
  pinch = null;
};
view.addEventListener("touchend", resetTouches, { passive: true });
view.addEventListener("touchcancel", resetTouches, { passive: true });
// iOS のブラウザが、3D の上のつまむ操作で、ページ全体を拡大してしまうのを防ぐ
for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
  view.addEventListener(name, (event) => event.preventDefault());
}

let dirty = true;
function requestRender() {
  dirty = true;
}
controls.addEventListener("change", () => {
  clampPan();
  requestRender();
});
// どちらを手前に描くか:
// - 横から見ているとき（二人の正面の向きと、カメラの向きが、ほぼ直角のとき）は、身長が低い方を前にする。
//   身長も同じなら、体重が軽い方を前にする。（横からでは、爪先の前後の差が、足の幅の違いにしかならないため）
// - それ以外では、足元（爪先）の位置で決める。カメラから見て、爪先が少しでも手前にある方を、前に描く。
//   爪先がまったく同じ位置なら、身長が低い方を前にする。身長も同じなら、体重が軽い方を前にする。
// 体が重なっても色が混ざらず、前の人が全体を見えるよう、前後の2回に分けて描く。
const SAME_TOE_M = 0.001; // これ以内の差（1mm）なら、同じ位置とみなす

// カメラが見ている向き（水平で、奥へ向かう向き）
function viewForward() {
  const forward = new THREE.Vector3().subVectors(controls.target, camera.position);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.setFromMatrixColumn(camera.matrixWorld, 1); // 真上から見ているときは、画面の上
  forward.y = 0;
  return forward.normalize();
}

// 足元の頂点のうち、カメラにいちばん近いものの、奥行き（小さいほど手前）
function toeDepth(figure, forward) {
  figure.group.updateMatrixWorld(true);
  const pos = figure.current;
  const v = new THREE.Vector3();
  let nearest = Infinity;
  for (const i of figure.footSlab) {
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(figure.mesh.matrixWorld);
    const depth = v.x * forward.x + v.z * forward.z;
    if (depth < nearest) nearest = depth;
  }
  return nearest;
}

const SIDE_VIEW_SIN = Math.sin((15 * Math.PI) / 180); // 正面の向きとカメラの向きが、直角から 15 度以内なら「横から」

// 横から見ているか（二人とも、正面の向きとカメラの向きが、ほぼ直角か）
function viewedFromSide(forward) {
  return IDS.every((id) => {
    const t = figures[id].group.rotation.y;
    return Math.abs(Math.sin(t) * forward.x + Math.cos(t) * forward.z) < SIDE_VIEW_SIN;
  });
}

// 身長が低い方、同じなら体重が軽い方（どちらも同じなら null）
function smallerFigureId() {
  if (state.A.height !== state.B.height) return state.A.height < state.B.height ? "A" : "B";
  const weightA = results.A?.weight ?? 0;
  const weightB = results.B?.weight ?? 0;
  if (Math.abs(weightA - weightB) > 0.05) return weightA < weightB ? "A" : "B";
  return null;
}

function frontFigureId() {
  if (!figures.A || !figures.B) return null;
  const forward = viewForward();
  if (viewedFromSide(forward)) return smallerFigureId();
  const depthA = toeDepth(figures.A, forward);
  const depthB = toeDepth(figures.B, forward);
  if (Math.abs(depthA - depthB) > SAME_TOE_M) return depthA < depthB ? "A" : "B";
  return smallerFigureId(); // 爪先が同じ位置なら、低い方（同じなら軽い方）。すべて同じなら null（普通の奥行き）
}

function renderFrame() {
  const front = frontFigureId();
  const show = ({ decorOn = false, backOn = false, frontOn = false, blueOn = false, linkOn = false }) => {
    decor.visible = decorOn;
    eyeMarks.visible = blueOn;
    linkGroup.visible = linkOn;
    for (const id of IDS) if (figures[id]) figures[id].group.visible = id === front ? frontOn : backOn;
  };
  const draw = (flags) => {
    show(flags);
    renderer.render(scene, camera);
  };
  renderer.autoClear = false;
  renderer.clear();
  draw({ decorOn: true, backOn: true }); // 背景・目盛り・奥の人（前後を決めないときは、二人とも）
  if (front) {
    // 赤い線は、奥の人には奥行きどおりに隠れ、手前の人には、そのあとで描く手前の人に必ず隠れる
    draw({ linkOn: true });
    renderer.clearDepth();
    draw({ frontOn: true }); // 手前の人（奥の人・赤い線より必ず前）
  }
  // 青い水平線と文字は、常に最前面。前後を決めないときは、赤い線を奥行きどおりに（手前の人体に隠れるように）描く
  draw({ blueOn: true, linkOn: !front });
  show({ decorOn: true, backOn: true, frontOn: true, blueOn: true, linkOn: true });
  updateOverlay();
}

renderer.setAnimationLoop(() => {
  if (!dirty) return;
  dirty = false;
  renderFrame();
});

function resize() {
  const w = view.clientWidth;
  const h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); // 見た目の大きさは CSS に任せる
  const aspect = w / h;
  // 縦: 床から 220cm の目盛りまで。縦長の画面では、横幅（目盛りの文字まで）が収まるよう範囲を広げる
  const halfHeight = Math.max(1.35, 1.65 / aspect) * stageScale;
  camera.left = -halfHeight * aspect;
  camera.right = halfHeight * aspect;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(resize).observe(view);

// 身長の目盛り（10cm 刻みの線、50cm ごとに数字）は、キャラクターより奥の壁に置く。
// 目線の高さを示す赤いラインも同じ壁に引く。グリッド床と一緒に、横向きのときは壁ごと回す。
const WALL_Z = -0.9;
const decor = new THREE.Group();
scene.add(decor);
// 目線のマーカーは、壁ではなく人体と同じ空間に置き、常に人体に重ねて描く（奥行きの判定を使わない）
const eyeMarks = new THREE.Group(); // 青い水平線
scene.add(eyeMarks);
const linkGroup = new THREE.Group(); // 赤い、目と目を結ぶ線
scene.add(linkGroup);
const eyeMarkOf = {};

// 目盛りの数字は、画面の左端に重ねて表示する（下の updateOverlay）。ここでは、奥の壁の目盛りの線と床だけを作る。
let rulerTopCm = 220;
let themeColors = { surface: "#ffffff", border: "#d5dbe5", muted: "#5d6879" };
function buildDecor() {
  decor.clear();
  const css = getComputedStyle(document.documentElement);
  themeColors = {
    surface: css.getPropertyValue("--surface").trim() || "#ffffff",
    border: css.getPropertyValue("--border").trim() || "#d5dbe5",
    muted: css.getPropertyValue("--muted").trim() || "#5d6879",
  };
  const muted = css.getPropertyValue("--muted").trim() || "#5d6879";
  const border = css.getPropertyValue("--border").trim() || "#d5dbe5";
  // 前後を分けて描くため、背景はシーンではなくレンダラーの塗りつぶし色にする
  renderer.setClearColor(new THREE.Color(getComputedStyle(view).backgroundColor));

  const S = stageScale;
  const grid = new THREE.GridHelper(4 * S, 40, muted, border);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  decor.add(grid);

  const wall = new THREE.Group();
  wall.position.z = WALL_Z * S;
  decor.add(wall);
  rulerTopCm = Math.max(220, Math.ceil((Math.max(state.A.height, state.B.height) + 10) / 50) * 50);
  const half = 8 * S; // 拡大・移動しても画面の端まで線が届く長さ
  const minor = [];
  const major = [];
  for (let cm = 10; cm <= rulerTopCm; cm += 10) (cm % 50 === 0 ? major : minor).push(-half, cm / 100, 0, half, cm / 100, 0);
  const lines = (points, opacity) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: muted, transparent: true, opacity }));
    line.frustumCulled = false;
    return line;
  };
  wall.add(lines(minor, 0.18), lines(major, 0.5));
  requestRender();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", buildDecor);

// 各キャラクターの目線の高さを示す、細く薄い青の線。それぞれの目の位置を通る水平な1本で、
// 二人の目を結ぶ方向に、両方の肩の外側の端まで引く（肩より外には出ない）。青い線は常に人体に重ねて描く。
// さらに、二人の目と目を結ぶ線を、水平線より濃い赤で引く。赤い線は、一番手前の人体に隠れる。
const EYE_LINE_COLOR = 0x4aa3ff;
const EYE_LINK_COLOR = 0xe5342f;
const eyeLink = new THREE.LineSegments(
  new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3)),
  new THREE.LineBasicMaterial({ color: EYE_LINK_COLOR, transparent: true, opacity: 0.75 }) // 奥行きを使い、手前の人体に隠れる
);
eyeLink.renderOrder = 6;
eyeLink.frustumCulled = false;
eyeLink.visible = false;
linkGroup.add(eyeLink);
const eyeWorld = [new THREE.Vector3(), new THREE.Vector3()]; // 目の中心（青い線・文字用）
const surfaceWorld = [new THREE.Vector3(), new THREE.Vector3()]; // 顔の表面（赤い線の端）

function updateEyeLink() {
  const figs = IDS.map((id) => figures[id]);
  const ready = figs.every(Boolean);
  eyeLink.visible = ready;
  for (const mark of Object.values(eyeMarkOf)) mark.line.visible = ready;
  if (!ready) return;

  const position = eyeLink.geometry.attributes.position;
  figs.forEach((figure, i) => {
    figure.group.updateMatrixWorld(true);
    eyeWorld[i].copy(figure.eyeLocal);
    figure.group.localToWorld(eyeWorld[i]);
    surfaceWorld[i].copy(figure.eyeSurfaceLocal);
    figure.group.localToWorld(surfaceWorld[i]);
    position.setXYZ(i, surfaceWorld[i].x, surfaceWorld[i].y, surfaceWorld[i].z);
  });
  position.needsUpdate = true;

  // 線の向き: 一人目の目から二人目の目へ向かう水平な方向。ほぼ同じ位置に重ねたときは、並べた方向。
  let dx = eyeWorld[1].x - eyeWorld[0].x;
  let dz = eyeWorld[1].z - eyeWorld[0].z;
  const length = Math.hypot(dx, dz);
  if (length < 0.02) [dx, dz] = viewName === "side" ? [0, -1] : [1, 0];
  else [dx, dz] = [dx / length, dz / length];
  const along = (p) => (p.x - eyeWorld[0].x) * dx + (p.z - eyeWorld[0].z) * dz;

  // 二人の肩の外側の端（その向きでの最小・最大）
  const v = new THREE.Vector3();
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const figure of figs) {
    const pos = figure.current;
    for (const i of figure.shoulderSlab) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(figure.mesh.matrixWorld);
      const t = along(v);
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (!Number.isFinite(tMin)) [tMin, tMax] = [-0.2, 0.2];

  IDS.forEach((id, i) => {
    const mark = eyeMarkOf[id];
    if (!mark) return;
    const t = along(eyeWorld[i]);
    const p = mark.line.geometry.attributes.position;
    const e = eyeWorld[i];
    p.setXYZ(0, e.x + dx * (tMin - t), e.y, e.z + dz * (tMin - t));
    p.setXYZ(1, e.x + dx * (tMax - t), e.y, e.z + dz * (tMax - t));
    p.needsUpdate = true;
  });
  requestRender();
}

function updateEyeMarks() {
  IDS.forEach((id) => {
    const figure = figures[id];
    if (!figure) return;
    let mark = eyeMarkOf[id];
    if (!mark) {
      const line = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3)),
        new THREE.LineBasicMaterial({ color: EYE_LINE_COLOR, transparent: true, opacity: 0.5, depthTest: false })
      );
      line.renderOrder = 4;
      line.frustumCulled = false;
      eyeMarks.add(line);
      mark = eyeMarkOf[id] = { line, text: "" };
    }
    mark.text = `${displayName(id)} 目線 ${Math.round(figure.eyeHeight * 100)}cm`;
  });
  updateEyeLink();
}

// ---------- 画面の端に固定する文字（身長の目盛りと、目線の高さ） ----------
// 拡大・移動・回転しても、同じ大きさで画面の端（目盛りは左端、目線は右端）に並ぶ。
// 縦位置だけを、実際の高さに合わせて動かす。目線の文字どうしが近いときは、上下に離す。
const overlay = document.createElement("div");
overlay.className = "overlay";
view.appendChild(overlay);
let overlayItems = [];
const NARROW_VIEW_PX = 600; // これより狭い画面（スマホ）では、目線の文字を、3D画面の外（すぐ上の帯）に出して、人体と重ならないようにする
const eyeStrip = document.getElementById("eyeStrip");
let eyeStripHtml = "";

function computeOverlayItems() {
  camera.updateMatrixWorld();
  const height = view.clientHeight;
  const v = new THREE.Vector3();
  const screenY = (point) => ((1 - v.copy(point).project(camera).y) / 2) * height;
  const items = [];

  // 目盛り: 拡大するほど細かく（10cm 刻みまで）、離れるほど粗く出す
  const pxPerCm = height / ((camera.top - camera.bottom) / camera.zoom) / 100;
  const step = [10, 20, 50, 100].find((s) => pxPerCm * s >= 55) ?? 100;
  const point = new THREE.Vector3();
  // 見下ろすと高さが画面上で潰れて数字が重なるので、近すぎるものは間引く（低い方を残す）
  let lastY = Infinity;
  for (let cm = step; cm <= rulerTopCm; cm += step) {
    const y = screenY(point.set(0, cm / 100, 0));
    if (y <= 8 || y >= height - 8 || Math.abs(y - lastY) < 20) continue;
    items.push({ side: "left", kind: "ruler", y, text: `${cm}cm` });
    lastY = y;
  }

  const eyes = IDS.map((id, i) => ({ side: "right", kind: "eye", y: screenY(eyeWorld[i]), text: eyeMarkOf[id]?.text }))
    .filter((item) => item.text);
  if (view.clientWidth < NARROW_VIEW_PX) return items; // 狭い画面では、目線の文字は3D画面の上の帯に出す（updateOverlay）
  eyes.sort((a, b) => a.y - b.y);
  const GAP = 26;
  if (eyes.length === 2 && eyes[1].y - eyes[0].y < GAP) {
    const push = (GAP - (eyes[1].y - eyes[0].y)) / 2;
    eyes[0].y -= push;
    eyes[1].y += push;
  }
  for (const item of eyes) item.y = clamp(item.y, 14, height - 14);
  return items.concat(eyes);
}

function updateEyeStrip() {
  const narrow = view.clientWidth < NARROW_VIEW_PX;
  eyeStrip.hidden = !narrow;
  if (!narrow) return;
  const html = IDS.filter((id) => eyeMarkOf[id]?.text)
    .map((id) => `<span class="eye-chip" style="--c: var(--${id === "A" ? "a" : "b"})"><i></i>${esc(eyeMarkOf[id].text)}</span>`)
    .join("");
  if (html !== eyeStripHtml) {
    eyeStrip.innerHTML = html;
    eyeStripHtml = html;
  }
}

// ---------- 真上から見た配置図 ----------
// 水平に見ている画面では、人体を奥・手前に動かしても、見た目の位置が変わらない（平行投影のため）。
// そこで、二人の立ち位置を真上から見た小さな図を、3D画面の右下に出す。上が奥、下が手前（正面から見たとき）。
// 人体の向き（正面は ▼ の向き）と、カメラのある向き（● の位置）も出す。
const topMap = document.createElement("canvas");
topMap.className = "topmap";
view.appendChild(topMap);
const MAP_COLOR = { A: "#ee9db5", B: "#e8cc66" };

function drawTopMap() {
  const size = view.clientWidth < NARROW_VIEW_PX ? 96 : 120;
  const dpr = Math.min(devicePixelRatio, 2);
  if (topMap.width !== Math.round(size * dpr)) {
    topMap.width = topMap.height = Math.round(size * dpr);
    topMap.style.width = topMap.style.height = `${size}px`;
  }
  const ctx = topMap.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = themeColors.surface + "d9";
  ctx.strokeStyle = themeColors.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, size - 1, size - 1, 10);
  ctx.fill();
  ctx.stroke();

  const half = size / 2;
  // 図に表示する範囲（±）。標準の並びが大きく見えるよう狭めにし、遠くへ動かしたときは広げる
  const farthest = Math.max(...IDS.map((id) => (figures[id] ? Math.max(Math.abs(figures[id].group.position.x), Math.abs(figures[id].group.position.z)) : 0)));
  const limit = Math.max(1.3 * stageScale, farthest + 0.35);
  const scale = (half - 12) / limit; // 1m あたりのピクセル
  ctx.strokeStyle = themeColors.border;
  ctx.beginPath(); // 中心の十字
  ctx.moveTo(half, 12); ctx.lineTo(half, size - 12);
  ctx.moveTo(12, half); ctx.lineTo(size - 12, half);
  ctx.stroke();
  ctx.fillStyle = themeColors.muted;
  ctx.font = "9px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("真上から", 6, 5);

  for (const id of IDS) {
    const figure = figures[id];
    if (!figure) continue;
    const p = figure.group.position;
    const h = state[id].height / 100;
    const rx = Math.max(2.5, 0.2 * (h / 1.7) * scale); // 肩幅の半分
    const rz = Math.max(1.8, 0.11 * (h / 1.7) * scale); // 厚みの半分
    ctx.save();
    ctx.translate(half + p.x * scale, half + p.z * scale);
    ctx.rotate(-figure.group.rotation.y);
    ctx.fillStyle = MAP_COLOR[id];
    ctx.strokeStyle = selected === id ? themeColors.muted : "transparent";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, rz, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath(); // 正面の向き
    ctx.moveTo(-3, rz + 1); ctx.lineTo(3, rz + 1); ctx.lineTo(0, rz + 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 8px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.translate(half + p.x * scale, half + p.z * scale);
    ctx.fillText(id, 0, 0);
    ctx.restore();
  }

  // カメラのある向き（正面から見ているときは、下）
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  const r = half - 5;
  ctx.fillStyle = themeColors.muted;
  ctx.beginPath();
  ctx.arc(half + Math.sin(az) * r, half + Math.cos(az) * r, 3, 0, Math.PI * 2);
  ctx.fill();
}

function updateOverlay() {
  updateEyeStrip();
  drawTopMap();
  overlayItems = computeOverlayItems();
  while (overlay.children.length < overlayItems.length) overlay.appendChild(document.createElement("div"));
  [...overlay.children].forEach((el, i) => {
    const item = overlayItems[i];
    el.hidden = !item;
    if (!item) return;
    el.className = `ov ${item.side} ${item.kind}`;
    el.textContent = item.text;
    el.style.top = `${item.y}px`;
  });
}

// 画像保存用に、同じ文字を画像に描き込む
function drawOverlay(ctx, scale) {
  const css = getComputedStyle(document.documentElement);
  const surface = css.getPropertyValue("--surface").trim() || "#ffffff";
  const muted = css.getPropertyValue("--muted").trim() || "#5d6879";
  ctx.font = `bold ${12 * scale}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const item of overlayItems) {
    const width = ctx.measureText(item.text).width + 12 * scale;
    const x = item.side === "left" ? 6 * scale : ctx.canvas.width - 6 * scale - width;
    const y = item.y * scale;
    if (item.kind === "eye") {
      ctx.fillStyle = surface + "d9";
      ctx.beginPath();
      ctx.roundRect(x, y - 10 * scale, width, 20 * scale, 6 * scale);
      ctx.fill();
    }
    ctx.fillStyle = item.kind === "eye" ? "#2f6fdb" : muted;
    ctx.fillText(item.text, x + 6 * scale, y);
  }
}

const figures = {};

// ---------- 画面（入力パネル） ----------
const fmt = (v, d = 1) => v.toFixed(d);
const signed = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);

function buildPanel(id) {
  const root = document.getElementById("panel" + id);
  root.append(document.getElementById("panelTemplate").content.cloneNode(true));
  const q = (sel) => root.querySelector(sel);
  const el = {
    root,
    heightRange: q('[data-input="heightRange"]'),
    height: q('[data-input="height"]'),
    muscle: q('[data-input="muscle"]'),
    bodyFat: q('[data-input="bodyFat"]'),
    weight: q('[data-input="weight"]'),
    muscleOut: q('[data-out="muscle"]'),
    bodyFatOut: q('[data-out="bodyFat"]'),
    bust: q('[data-input="bust"]'),
    bustOut: q('[data-out="bust"]'),
    bustField: q('[data-role="bustField"]'),
    patternName: q('[data-input="patternName"]'),
    patterns: q('[data-role="patterns"]'),
    presets: q('[data-role="presets"]'),
    result: q('[data-role="result"]'),
  };
  const nameInput = q('[data-input="name"]');
  el.name = nameInput;
  nameInput.value = state[id].name;
  nameInput.placeholder = DEFAULT_NAMES[id];
  nameInput.addEventListener("input", () => {
    state[id].name = nameInput.value;
    updateEyeMarks();
    renderCompare();
    persist();
  });
  // label と input を対応づける（スクリーンリーダー・クリックでのフォーカス用）
  const heightLabelFor = q('[data-for="height"]');
  const weightLabelFor = q('[data-for="weight"]');
  el.height.id = `height${id}`;
  el.weight.id = `weight${id}`;
  heightLabelFor.setAttribute("for", el.height.id);
  weightLabelFor.setAttribute("for", el.weight.id);
  el.heightRange.setAttribute("aria-label", "身長スライダー");

  const s = state[id];
  const change = () => update(id);

  root.querySelectorAll("[data-gender]").forEach((button) =>
    button.addEventListener("click", () => {
      s.gender = button.dataset.gender;
      s.bodyFat = clamp(s.bodyFat, ...RANGES[s.gender].bodyFat);
      s.weight = null;
      el.weight.value = "";
      change();
    })
  );

  el.heightRange.addEventListener("input", () => {
    s.height = Number(el.heightRange.value);
    change();
  });
  el.height.addEventListener("input", () => {
    const v = Number(el.height.value);
    if (Number.isFinite(v) && v >= RANGES[s.gender].height[0] && v <= RANGES[s.gender].height[1]) {
      s.height = Math.round(v);
      change();
    }
  });
  el.height.addEventListener("change", () => {
    s.height = clamp(Math.round(Number(el.height.value) || s.height), ...RANGES[s.gender].height);
    change();
  });

  el.muscle.addEventListener("input", () => {
    s.muscle = Number(el.muscle.value);
    change();
  });
  q('[data-role="savePattern"]').addEventListener("click", () => savePattern(id));
  el.patternName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") savePattern(id);
  });
  el.bust.addEventListener("input", () => {
    s.bust = Number(el.bust.value);
    change();
  });
  el.bodyFat.addEventListener("input", () => {
    s.bodyFat = Number(el.bodyFat.value);
    s.weight = null; // 体脂肪率を手動で触ったら、体重指定は解除する
    el.weight.value = "";
    change();
  });

  el.weight.addEventListener("input", () => {
    const v = Number(el.weight.value);
    s.weight = el.weight.value !== "" && Number.isFinite(v) && v > 0 ? v : null;
    change();
  });
  q('[data-role="clearWeight"]').addEventListener("click", () => {
    s.weight = null;
    el.weight.value = "";
    change();
  });

  return el;
}

function renderPresets(id) {
  const el = panels[id];
  const s = state[id];
  el.presets.replaceChildren();
  for (const preset of PRESETS[s.gender]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.name;
    button.addEventListener("click", () => {
      s.muscle = preset.muscle;
      s.bodyFat = preset.bodyFat;
      s.weight = null;
      el.weight.value = "";
      update(id);
    });
    el.presets.append(button);
  }
}

function resultHtml(r, s) {
  const notes = r.notes.map((n) => `<p class="warn">${n}</p>`).join("");
  return `
    <div class="big">${fmt(r.weight)}<small> kg</small></div>
    <dl>
      <dt>BMI</dt><dd>${fmt(r.bmi)}（${r.category}）</dd>
      <dt>体脂肪率</dt><dd>${fmt(r.bodyFat, 0)} %</dd>
      <dt>脂肪量</dt><dd>${fmt(r.fatMass)} kg</dd>
      <dt>除脂肪量</dt><dd>${fmt(r.leanMass)} kg</dd>
      <dt>標準体重（BMI22）</dt><dd>${fmt(r.standardWeight)} kg（${signed(r.weight - r.standardWeight)} kg）</dd>
      <dt>BMI18.5〜25の体重</dt><dd>${fmt(r.weightRange[0])}〜${fmt(r.weightRange[1])} kg</dd>
    </dl>
    <p class="desc">${r.description}</p>${notes}`;
}

function update(id) {
  const s = state[id];
  const el = panels[id];
  const range = RANGES[s.gender];

  const r = calculate({
    gender: s.gender,
    heightCm: s.height,
    muscle: s.muscle,
    bodyFat: s.bodyFat,
    weightKg: s.weight,
  });
  if (s.weight != null) {
    // 体重指定時は、逆算した体脂肪率と、必要なら調整された筋肉量を、スライダーに反映
    s.bodyFat = r.bodyFat;
    s.muscle = r.muscle;
  }
  results[id] = r;
  applyStageScale();

  el.root.querySelectorAll("[data-gender]").forEach((b) => b.classList.toggle("on", b.dataset.gender === s.gender));
  el.heightRange.min = range.height[0];
  el.heightRange.max = range.height[1];
  el.heightRange.value = s.height;
  if (document.activeElement !== el.height) el.height.value = s.height;
  el.muscle.min = range.muscle[0];
  el.muscle.max = range.muscle[1];
  el.muscle.value = s.muscle;
  el.muscleOut.textContent = `${fmt(s.muscle, 0)}%`;
  el.bodyFat.min = range.bodyFat[0];
  el.bodyFat.max = range.bodyFat[1];
  el.bodyFat.value = s.bodyFat;
  el.bodyFatOut.textContent = `${fmt(s.bodyFat, 0)}%`;
  el.bust.value = s.bust;
  el.bustOut.textContent = `${s.bust}%`;
  el.bustField.hidden = s.gender !== "female"; // 胸の大きさは女性のみ
  if (el.presets.dataset.gender !== s.gender) {
    renderPresets(id);
    el.presets.dataset.gender = s.gender;
  }
  el.result.innerHTML = resultHtml(r, s);

  const figure = figures[id];
  if (figure) {
    figure.set({ gender: s.gender, heightCm: s.height, muscle: r.shape.muscle, weight: r.shape.weight, bust: s.bust / 100 });
    updateEyeMarks();
  }
  renderCompare();
  persist();
}

function renderCompare() {
  const [a, b] = [state.A, state.B];
  const [ra, rb] = [results.A, results.B];
  if (!ra || !rb) return;
  const dh = a.height - b.height;
  const dw = ra.weight - rb.weight;
  const heightText =
    dh === 0 ? "身長は同じ" : `身長は<strong>${Math.abs(dh)}cm</strong>${dh > 0 ? "高く" : "低く"}`;
  const weightText =
    Math.abs(dw) < 0.05 ? "体重はほぼ同じ" : `体重は<strong>${fmt(Math.abs(dw))}kg</strong>${dw > 0 ? "重い" : "軽い"}`;
  document.getElementById("compare").innerHTML =
    `<strong>${esc(displayName("A"))}</strong>（${GENDER_LABEL[a.gender]}）は<strong>${esc(displayName("B"))}</strong>（${GENDER_LABEL[b.gender]}）より、` +
    `${heightText}、${weightText}（BMI差 ${signed(ra.bmi - rb.bmi)}）。`;
}

// ---------- ボタン類 ----------
const toastEl = document.getElementById("toast");
let toastTimer = 0;
function toast(message) {
  toastEl.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.textContent = ""), 4000);
}

document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

document.getElementById("resetView").addEventListener("click", () => {
  layoutFigures(); // 動かした人体の立ち位置を、初期の位置に戻す
  resetCamera(); // 拡大・移動・回転を、標準の見え方に戻す
  scheduleHistoryCommit(); // 立ち位置が変わった場合は、戻る・進むに記録する
});

document.getElementById("share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#${hashOf(state)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("共有URLをコピーしました。");
  } catch {
    toast(`コピーできませんでした。次のURLを手動でコピーしてください: ${url}`);
  }
});

document.getElementById("savePng").addEventListener("click", () => {
  renderFrame(); // 描画直後に同じ処理内でコピーする
  const src = renderer.domElement;
  const css = getComputedStyle(document.documentElement);
  const lines = IDS.map((id) => {
    const s = state[id];
    const r = results[id];
    return `${displayName(id)}（${GENDER_LABEL[s.gender]}）${s.height}cm / ${fmt(r.weight)}kg / BMI ${fmt(r.bmi)} / 体脂肪率 ${fmt(r.bodyFat, 0)}% / 目線 ${Math.round(figures[id].eyeHeight * 100)}cm`;
  });

  // 長い名前でも収まるように、文字の大きさを下げて合わせる（A が上段、B が下段）
  const measure = document.createElement("canvas").getContext("2d");
  let size = Math.round(src.width / 30);
  const fits = () => {
    measure.font = `${size}px sans-serif`;
    return Math.max(...lines.map((t) => measure.measureText(t).width)) + size * 3 <= src.width;
  };
  while (size > 10 && !fits()) size--;
  const rowHeight = Math.round(size * 1.9);

  const canvas = document.createElement("canvas");
  canvas.width = src.width;
  canvas.height = src.height + rowHeight * 2 + Math.round(size * 0.4);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = css.getPropertyValue("--surface").trim() || "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0);
  drawOverlay(ctx, src.width / view.clientWidth);
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  IDS.forEach((id, i) => {
    const y = src.height + Math.round(size * 0.2) + rowHeight * i + rowHeight / 2;
    ctx.fillStyle = `#${FIGURE_COLOR[id].toString(16).padStart(6, "0")}`;
    ctx.beginPath();
    ctx.arc(size * 1.2, y, size * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = css.getPropertyValue("--text").trim() || "#000";
    ctx.fillText(lines[i], size * 2.2, y);
  });
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "character-compare.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});

// ---------- 人体のダブルクリック選択と、横への移動 ----------
// ダブルクリックで選択（光る）。選択中の人体をドラッグすると、画面の左右方向に平行移動する（高さは変えない）。
// 選択していない場所のドラッグは、これまでどおり視点の回転。もう一度ダブルクリックするか、空きをダブルクリックで解除。
const raycaster = new THREE.Raycaster();
let selected = null;
let drag = null;

function pickFigure(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const meshes = IDS.filter((id) => figures[id]).map((id) => figures[id].mesh);
  const hits = raycaster.intersectObjects(meshes, false).map((hit) => IDS.find((id) => figures[id].mesh === hit.object));
  if (!hits.length) return null;
  // 重なっているときは、手前に描かれている方（見えている方）を選ぶ
  const front = frontFigureId();
  return hits.includes(front) ? front : hits[0];
}

function select(id) {
  selected = id;
  document.querySelectorAll("[data-move]").forEach((b) => b.classList.toggle("on", b.dataset.move === id));
  for (const other of IDS) figures[other]?.setHighlight(other === id);
  toast(id ? `${displayName(id)}を選択中。ドラッグで左右・前後に移動できます（斜めには動きません。解除は、「${id}を動かす」ボタンをもう一度押すか、Esc キー）。` : "");
  requestRender();
}

// スマホのブラウザは、ボタンの押下を二重に通知することがあり、選んだ直後に解除されてしまうので、続けて来たものは無視する
let lastMoveClick = 0;
document.querySelectorAll("[data-move]").forEach((button) =>
  button.addEventListener("click", () => {
    const now = performance.now();
    if (now - lastMoveClick < 500) return;
    lastMoveClick = now;
    select(selected === button.dataset.move ? null : button.dataset.move);
  })
);
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && selected) select(null); // Esc で、人体の選択を解除
});

renderer.domElement.addEventListener("dblclick", (event) => {
  const id = pickFigure(event);
  if (!id) return; // 空きの場所では選択を変えない（スマホで、意図せず届いたダブルタップで解除されないように）
  select(id === selected ? null : id); // 人体をダブルクリックすると選択、選択中の人体なら解除
});

const AXIS_LOCK_PX = 8; // 動かし始めて、これだけ動いたら、左右か前後かを決める

// OrbitControls より先に処理し、選択中の人体の上で押したときだけ移動を始める
view.addEventListener(
  "pointerdown",
  (event) => {
    if (!selected || event.button !== 0 || event.shiftKey) return;
    // マウスは、選択中の人体の上でドラッグしたときだけ。タッチは、1本指なら、画面のどこでも（2本指は表示の移動）
    if (event.pointerType === "touch" ? touchPointers.size > 1 : pickFigure(event) !== selected) return;
    drag = { id: selected, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, axis: null, pointerId: event.pointerId };
    controls.enabled = false;
    view.setPointerCapture(event.pointerId);
  },
  true
);
view.addEventListener("pointermove", (event) => {
  if (drag && touchPointers.size > 1) endDrag(); // 2本指になったら、人体の移動はやめて、表示の移動にする
  if (!drag) return;
  // 左右（画面の横）か、前後（画面の縦: 上へ動かすと奥、下へ動かすと手前）の、どちらか一方にだけ動かす。
  // どちらかは、動かし始めに一度だけ決める（斜めには動かさない）。高さ（Y座標）は変えない。
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  drag.x = event.clientX;
  drag.y = event.clientY;
  let movedPx;
  if (!drag.axis) {
    const totalX = event.clientX - drag.startX;
    const totalY = event.clientY - drag.startY;
    if (Math.max(Math.abs(totalX), Math.abs(totalY)) < AXIS_LOCK_PX) return; // 少しの動きでは、向きを決めない
    drag.axis = Math.abs(totalX) >= Math.abs(totalY) ? "x" : "y";
    movedPx = drag.axis === "x" ? totalX : totalY; // 向きが決まるまでに動いた分も、まとめて反映する
  } else {
    movedPx = drag.axis === "x" ? dx : dy;
  }
  const worldPerPixel = (camera.right - camera.left) / camera.zoom / view.clientWidth;
  const direction = new THREE.Vector3();
  if (drag.axis === "x") {
    direction.setFromMatrixColumn(camera.matrixWorld, 0); // 画面の右
  } else {
    direction.subVectors(controls.target, camera.position); // カメラが見ている向き（奥）
    direction.y = 0;
    if (direction.lengthSq() < 1e-6) direction.setFromMatrixColumn(camera.matrixWorld, 1); // 真上から見ているときは、画面の上
    movedPx = -movedPx; // 画面の上へ動かすと奥、下へ動かすと手前
  }
  direction.y = 0;
  direction.normalize();
  const group = figures[drag.id].group;
  group.position.addScaledVector(direction, movedPx * worldPerPixel);
  const limit = 2 * stageScale;
  group.position.x = THREE.MathUtils.clamp(group.position.x, -limit, limit);
  group.position.z = THREE.MathUtils.clamp(group.position.z, -limit, limit);
  updateEyeLink();
});
const endDrag = () => {
  if (!drag) return;
  drag = null;
  controls.enabled = true;
  commitHistory(); // 立ち位置を動かしたら、1工程として記録する
};
view.addEventListener("pointerup", endDrag);
view.addEventListener("pointercancel", endDrag);

// ---------- 戻る・進む ----------
// 入力（名前・性別・身長・筋肉量・体脂肪率・体重指定）と、人体の立ち位置・並べ方を、1工程ずつ記録する。
// スライダーを動かし続けている間は1つにまとめ、止めてから約0.5秒後に1工程として記録する。
// 視点の回転やズームは記録しない。最大 HISTORY_LIMIT 工程まで戻れる。
const HISTORY_LIMIT = 100;
const history_ = { stack: [], index: -1 };
let historyReady = false;
let restoring = false;
let commitTimer = 0;
const undoButton = document.getElementById("undo");
const redoButton = document.getElementById("redo");

function snapshot() {
  const snap = { view: viewName, pos: {} };
  for (const id of IDS) {
    const { name, gender, height, muscle, bodyFat, weight, bust } = state[id];
    snap[id] = { name, gender, height, muscle, bodyFat, weight, bust };
    const p = figures[id]?.group.position;
    snap.pos[id] = p ? [p.x, p.z] : null;
  }
  return JSON.stringify(snap);
}

function updateHistoryButtons() {
  undoButton.disabled = history_.index <= 0;
  redoButton.disabled = history_.index >= history_.stack.length - 1;
}

function commitHistory() {
  clearTimeout(commitTimer);
  if (!historyReady || restoring) return;
  const snap = snapshot();
  if (snap === history_.stack[history_.index]) return;
  history_.stack.length = history_.index + 1; // 戻した状態から新しい操作をしたら、進む側の履歴は捨てる
  history_.stack.push(snap);
  if (history_.stack.length > HISTORY_LIMIT + 1) history_.stack.shift();
  history_.index = history_.stack.length - 1;
  updateHistoryButtons();
}

function scheduleHistoryCommit() {
  if (!historyReady || restoring) return;
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commitHistory, 500);
}

function restoreSnapshot(json) {
  const snap = JSON.parse(json);
  restoring = true;
  try {
    viewName = snap.view;
    syncViewButtons();
    for (const id of IDS) {
      Object.assign(state[id], snap[id]);
      panels[id].name.value = state[id].name;
      panels[id].weight.value = state[id].weight ?? "";
      update(id);
    }
    orientFigures();
    for (const id of IDS) {
      const p = snap.pos[id];
      if (p && figures[id]) figures[id].group.position.set(p[0], 0, p[1]);
    }
    updateEyeMarks();
    persist();
    requestRender();
  } finally {
    restoring = false;
  }
  updateHistoryButtons();
}

function stepHistory(direction) {
  commitHistory(); // 記録待ちの操作があれば、先に確定する
  const next = history_.index + direction;
  if (next < 0 || next >= history_.stack.length) return;
  history_.index = next;
  restoreSnapshot(history_.stack[next]);
  const left = direction < 0 ? history_.index : history_.stack.length - 1 - history_.index;
  toast(`${direction < 0 ? "戻しました" : "進めました"}（さらに${left}工程${direction < 0 ? "戻せます" : "進められます"}）。`);
}

undoButton.addEventListener("click", () => stepHistory(-1));
redoButton.addEventListener("click", () => stepHistory(1));
addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const tag = event.target.tagName;
  const typing = (tag === "INPUT" && event.target.type !== "range") || tag === "TEXTAREA";
  if (typing) return; // 文字や数値を入力しているときは、ブラウザ標準の取り消しを使う
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) stepHistory(-1);
  else if (key === "y" || (key === "z" && event.shiftKey)) stepHistory(1);
  else return;
  event.preventDefault();
});

// ---------- パターンの保存と呼び出し ----------
// キャラクターの名前と数値（性別・身長・筋肉量・体脂肪率・胸の大きさ）に、パターン名を付けて保存し、
// ボタン一つで、AでもBでも好きな方に呼び出せる。呼び出すと、保存したときのキャラクター名になる。ブラウザに保存される。
const PATTERN_KEY = "character-weight-simulator.patterns.v1";
const PATTERN_LIMIT = 30;

function loadPatterns() {
  try {
    const raw = JSON.parse(localStorage.getItem(PATTERN_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p) => p && typeof p.id === "string" && typeof p.label === "string")
      .slice(0, PATTERN_LIMIT)
      .map((p) => ({
        id: p.id,
        label: p.label.slice(0, 20),
        ...sanitize(p, defaults().A),
        // 名前を保存していない古いパターンは、呼び出しても名前を変えない
        name: typeof p.name === "string" ? p.name.slice(0, 20) : null,
      }));
  } catch {
    return [];
  }
}
let patterns = loadPatterns();

function storePatterns() {
  try {
    localStorage.setItem(PATTERN_KEY, JSON.stringify(patterns));
  } catch {
    toast("このブラウザでは、パターンを保存できませんでした。");
  }
}

const patternSummary = (p) =>
  `${p.name ? `${p.name} / ` : ""}${GENDER_LABEL[p.gender]} ${p.height}cm / 筋肉${p.muscle}% / 体脂肪率${Math.round(p.bodyFat)}%` +
  (p.gender === "female" ? ` / 胸${p.bust}%` : "");

function renderPatterns() {
  for (const id of IDS) {
    const box = panels[id].patterns;
    box.replaceChildren();
    if (!patterns.length) {
      const hint = document.createElement("span");
      hint.className = "empty";
      hint.textContent = "まだありません。今の数値に名前を付けて「保存」を押すと、ここに並びます。";
      box.append(hint);
      continue;
    }
    for (const pattern of patterns) {
      const chip = document.createElement("span");
      chip.className = "chip-group";
      const load = document.createElement("button");
      load.type = "button";
      load.textContent = pattern.label;
      load.title = `${patternSummary(pattern)}\nクリックで ${displayName(id)} に呼び出す${pattern.name ? `（名前は「${pattern.name}」に変わります）` : ""}`;
      load.addEventListener("click", () => loadPattern(id, pattern));
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "×";
      del.className = "del";
      del.setAttribute("aria-label", `パターン「${pattern.label}」を削除`);
      del.title = "このパターンを削除";
      del.addEventListener("click", () => deletePattern(pattern));
      chip.append(load, del);
      box.append(chip);
    }
  }
}

function savePattern(id) {
  if (patterns.length >= PATTERN_LIMIT) {
    toast(`パターンは${PATTERN_LIMIT}個まで保存できます。不要なものを削除してください。`);
    return;
  }
  const s = state[id];
  const input = panels[id].patternName;
  const label = input.value.trim().slice(0, 20) || `パターン${patterns.length + 1}`;
  const { name, gender, height, muscle, bodyFat, bust } = s;
  patterns.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label, name, gender, height, muscle, bodyFat, bust });
  storePatterns();
  input.value = "";
  renderPatterns();
  toast(`「${label}」を保存しました。`);
}

function loadPattern(id, pattern) {
  const s = state[id];
  const { name, ...values } = sanitize(pattern, s);
  Object.assign(s, values, { weight: null });
  if (pattern.name !== null) s.name = name; // 保存したときの名前に変える
  panels[id].name.value = s.name;
  panels[id].weight.value = "";
  update(id);
  toast(`「${pattern.label}」を ${displayName(id)} に呼び出しました。`);
}

function deletePattern(pattern) {
  patterns = patterns.filter((p) => p.id !== pattern.id);
  storePatterns();
  renderPatterns();
  toast(`「${pattern.label}」を削除しました。`);
}

// ---------- 起動 ----------
for (const id of IDS) {
  panels[id] = buildPanel(id);
  update(id);
}
renderPatterns();
buildDecor();
const initialView = new URLSearchParams(location.search).get("view");
setView(initialView in VIEWS ? initialView : "front"); // ?view=side で最初から横向き
resize();

try {
  await Promise.all(
    IDS.map(async (id) => {
      const figure = await loadFigure(state[id].gender, FIGURE_COLOR[id]);
      scene.add(figure.group);
      figures[id] = figure;
      layoutFigures();
      update(id);
    })
  );
  document.getElementById("loading").remove();
  history_.stack = [snapshot()];
  history_.index = 0;
  historyReady = true;
  updateHistoryButtons();
} catch (error) {
  document.getElementById("loading").textContent =
    "3Dモデルを読み込めませんでした。ローカルで開く場合は、簡易サーバー経由で開いてください。";
  console.error(error);
}
