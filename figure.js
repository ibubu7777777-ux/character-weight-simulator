// MakeHuman 由来の人体メッシュ（日本人想定・成人）を、筋肉・体重の値で変形させ、まっすぐ立つ姿勢に整える。
import * as THREE from "three";

// 腕・脚を真下に向けたあと、外側へ少し開く角度（度）。太い・筋肉質の体ほど大きくして、体へのめり込みを避ける
const ARM_OPEN_MIN_DEG = 2;
const ARM_OPEN_MAX_DEG = 12;
const LEG_OPEN_MIN_DEG = 1;
const LEG_OPEN_MAX_DEG = 6;
// 親指を、人差し指の向きへどれだけ寄せるか（0〜1）。他の4本は中指と平行にそろえる
const THUMB_TOWARD_INDEX = 0.6;

const MUSCLES = 3;
const WEIGHTS = 3;
const SIDES = ["L", "R"];

// 0〜1 の値を [最小, 標準, 最大] の3つの重みに分ける（0.5 が標準）
function triWeights(t) {
  const low = Math.max(0, 1 - 2 * t);
  const high = Math.max(0, 2 * t - 1);
  return [low, 1 - low - high, high];
}

// 3Dデータは、更新されたときに古いものを使い続けないよう、読み込みのたびに更新の有無を確認する（変わっていなければ再取得しない）
const fresh = (url) => fetch(url, { cache: "no-cache" });

async function loadBinary(url, meta, gender) {
  const buf = await (await fresh(url)).arrayBuffer();
  const n = meta.nPoints; // 体の頂点 + 関節の点
  // 女性のファイルには、最後に「胸が最小」「胸が最大」の2つが付く
  const nTargets = meta.races.length + MUSCLES * WEIGHTS + (gender === "female" ? meta.bustTargets : 0);
  let offset = 0;
  const positions = new Float32Array(buf, offset, n * 3);
  offset += n * 3 * 4;
  const indices = new Uint32Array(buf, offset, meta.nTris * 3);
  offset += meta.nTris * 3 * 4;
  const deltas = [];
  for (let i = 0; i < nTargets; i++) {
    deltas.push(new Float32Array(buf, offset, n * 3));
    offset += n * 3 * 4;
  }
  return { positions, indices, deltas };
}

// 性別ごとのデータは1回だけ読み込み、全キャラクターで共有する
let datasetPromise = null;
function loadDataset() {
  datasetPromise ??= (async () => {
    const meta = await (await fresh("models/meta.json")).json();
    const [male, female, skin] = await Promise.all([
      loadBinary("models/male.bin", meta, "male"),
      loadBinary("models/female.bin", meta, "female"),
      fresh("models/arms.bin").then((r) => r.arrayBuffer()),
    ]);
    // arms.bin: 体の頂点ごとの重み(uint8)を、meta.weightArrays の順に並べたもの
    const weights = {};
    meta.weightArrays.forEach((name, i) => {
      const bytes = new Uint8Array(skin, i * meta.nVerts, meta.nVerts);
      weights[name] = Float32Array.from(bytes, (b) => b / 255);
    });
    return { meta, data: { male, female }, weights };
  })();
  return datasetPromise;
}

export class Figure {
  constructor(dataset, gender, color) {
    this.meta = dataset.meta;
    this.dataByGender = dataset.data;
    this.skinWeights = dataset.weights;
    this.gender = gender;
    const data = this.dataByGender[gender];
    this.current = new Float32Array(data.positions.length);
    const geometry = new THREE.BufferGeometry();
    // 末尾の関節の点は三角形に使われないので、描画には影響しない
    geometry.setAttribute("position", new THREE.BufferAttribute(this.current, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1)); // 男女で三角形は共通
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0 })
    );
    this.mesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.eyeLocal = new THREE.Vector3();
    this.eyeSurfaceLocal = new THREE.Vector3(); // 目の間の、顔の表面の位置
    this.eyeHeight = 0;
    this.shoulderSlab = new Int32Array(0);
    this.heightCm = 170;
    this.muscle = 0.5;
    this.weight = 0.5;
    this.bust = 0.5; // 胸の大きさ（女性のみ。0〜1、0.5 が標準）
    this.update();
  }

  set({ gender, heightCm, muscle, weight, bust }) {
    if (gender !== undefined) this.gender = gender;
    if (heightCm !== undefined) this.heightCm = heightCm;
    if (muscle !== undefined) this.muscle = muscle;
    if (weight !== undefined) this.weight = weight;
    if (bust !== undefined) this.bust = bust;
    this.update();
  }

  // [性別・日本人の基本形状] と [筋肉 × 体重] の9つのターゲットの重み
  targetWeights() {
    const mW = triWeights(this.muscle);
    const wW = triWeights(this.weight);
    const out = [1]; // 基本形状は常に全量
    for (let m = 0; m < MUSCLES; m++)
      for (let w = 0; w < WEIGHTS; w++) out.push(mW[m] * wW[w]);
    if (this.gender === "female") out.push(Math.max(0, 1 - 2 * this.bust), Math.max(0, 2 * this.bust - 1)); // 胸が小さい側・大きい側
    return out;
  }

  update() {
    const { positions, deltas } = this.dataByGender[this.gender];
    const weights = this.targetWeights();
    const cur = this.current;
    cur.set(positions);
    for (let t = 0; t < weights.length; t++) {
      const w = weights[t];
      if (w < 1e-4) continue;
      const d = deltas[t];
      for (let i = 0; i < cur.length; i++) cur[i] += d[i] * w;
    }
    this.standStraight();

    // 身長は、姿勢を整えたあとの頭の先〜足の裏で測る（脚が開いたままだと実際より低く測れてしまう）
    const n = this.meta.nVerts;
    let top = -Infinity;
    let bottom = Infinity;
    for (let i = 0; i < n; i++) {
      const y = cur[i * 3 + 1];
      if (y > top) top = y;
      if (y < bottom) bottom = y;
    }
    const scale = this.heightCm / 100 / (top - bottom); // メッシュ単位 → メートル
    this.mesh.scale.setScalar(scale);
    this.mesh.position.y = -bottom * scale;
    // 両目の中心。キャラクターのグループ座標（メートル）で持つ
    const { eyeL, eyeR } = this.meta.points;
    this.eyeLocal.set(
      ((cur[eyeL * 3] + cur[eyeR * 3]) / 2) * scale,
      ((cur[eyeL * 3 + 1] + cur[eyeR * 3 + 1]) / 2 - bottom) * scale,
      ((cur[eyeL * 3 + 2] + cur[eyeR * 3 + 2]) / 2) * scale
    );
    this.eyeHeight = this.eyeLocal.y;

    // 目の間の顔の表面（顔の外側）の位置。両目の中心の周り 1.4cm にある頂点のうち、いちばん前（+z）にあるもの。
    // 目と目を結ぶ赤い線の端に使う（目の中心は顔の内側にあるため）。
    const eyeX = (cur[eyeL * 3] + cur[eyeR * 3]) / 2;
    const eyeY = (cur[eyeL * 3 + 1] + cur[eyeR * 3 + 1]) / 2;
    const radius = 0.014 / scale;
    let frontZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = cur[i * 3] - eyeX;
      const dy = cur[i * 3 + 1] - eyeY;
      if (dx * dx + dy * dy <= radius * radius && cur[i * 3 + 2] > frontZ) frontZ = cur[i * 3 + 2];
    }
    if (Number.isFinite(frontZ)) {
      this.eyeSurfaceLocal.set(eyeX * scale, this.eyeLocal.y, frontZ * scale + 0.002); // 2mm だけ外に出して、肌に埋もれないようにする
    } else {
      this.eyeSurfaceLocal.copy(this.eyeLocal);
    }

    // 肩の高さにある頂点（肩の外側の端を求めるのに使う）。目線の線を、肩の幅より外に伸ばさないために持つ
    const { shoulderL, shoulderR } = this.meta.points;
    const shoulderY = (cur[shoulderL * 3 + 1] + cur[shoulderR * 3 + 1]) / 2;
    const tolerance = 0.022 * (top - bottom);
    const slab = [];
    for (let i = 0; i < n; i++) if (Math.abs(cur[i * 3 + 1] - shoulderY) <= tolerance) slab.push(i);
    this.shoulderSlab = Int32Array.from(slab);
    const geo = this.mesh.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere(); // ダブルクリックの当たり判定に使う
  }

  // 選択中は全体を少し明るく光らせる
  setHighlight(on) {
    this.mesh.material.emissive.setHex(on ? 0x4a4a4a : 0x000000);
  }

  // 素体のAポーズ（腕・脚が開き、指が広がり、肘が曲がっている）を、まっすぐ立つ姿勢に整える。
  // 関節の点はすべて姿勢を整える前の位置を使うので、先に全部読み取ってから順に回す。
  standStraight() {
    const { points, nVerts } = this.meta;
    const cur = this.current;
    const pt = (name) => new THREE.Vector3(cur[points[name] * 3], cur[points[name] * 3 + 1], cur[points[name] * 3 + 2]);
    const bulk = Math.max(0, this.weight - 0.5) * 2 * 0.6 + Math.max(0, this.muscle - 0.5) * 2 * 0.4;
    const open = (min, max) => ((min + (max - min) * Math.min(1, bulk)) * Math.PI) / 180;
    const armOpen = open(ARM_OPEN_MIN_DEG, ARM_OPEN_MAX_DEG);
    const legOpen = open(LEG_OPEN_MIN_DEG, LEG_OPEN_MAX_DEG);

    for (const side of SIDES) {
      const w = (name) => this.skinWeights[name + side];
      const shoulder = pt("shoulder" + side);
      const elbow = pt("elbow" + side);
      const wrist = pt("wrist" + side);
      const hip = pt("hip" + side);
      const ankle = pt("ankle" + side);
      const fingers = [1, 2, 3, 4, 5].map((n) => ({
        n,
        base: pt(`finger${n}Base${side}`),
        dir: pt(`finger${n}Tip${side}`).sub(pt(`finger${n}Base${side}`)).normalize(),
      }));

      // 1) 指: 中指と平行にそろえる（まっすぐ伸ばしたまま）。親指は人差し指のほうへ寄せる
      const middle = fingers[2].dir;
      for (const finger of fingers) {
        if (finger.n === 3) continue;
        const target =
          finger.n === 1 ? finger.dir.clone().lerp(fingers[1].dir, THUMB_TOWARD_INDEX).normalize() : middle;
        _quat.setFromUnitVectors(finger.dir, target);
        rotateWeighted(cur, nVerts, w("finger" + finger.n), finger.base, _quat);
      }

      // 2) 肘を伸ばす: 前腕の向きを、上腕（肩→肘）の向きに揃える
      const upper = elbow.clone().sub(shoulder).normalize();
      _quat.setFromUnitVectors(wrist.clone().sub(elbow).normalize(), upper);
      rotateWeighted(cur, nVerts, w("fore"), elbow, _quat);

      // 3) 腕全体を、肩を支点に真下（体の外側へ少しだけ開く）へ向ける
      const armOutward = shoulder.x > 0 ? 1 : -1;
      _quat.setFromUnitVectors(upper, new THREE.Vector3(armOutward * Math.sin(armOpen), -Math.cos(armOpen), 0));
      rotateWeighted(cur, nVerts, w("arm"), shoulder, _quat);

      // 4) 脚全体を、股関節を支点に真下（外側へ少しだけ開く）へ向ける
      const legOutward = hip.x > 0 ? 1 : -1;
      _quat.setFromUnitVectors(
        ankle.clone().sub(hip).normalize(),
        new THREE.Vector3(legOutward * Math.sin(legOpen), -Math.cos(legOpen), 0)
      );
      rotateWeighted(cur, nVerts, w("leg"), hip, _quat);
    }
  }
}

const _quat = new THREE.Quaternion();
const _vec = new THREE.Vector3();

// weights の重みに応じて、頂点を pivot を中心に回転させる（0 なら動かさず、1 なら完全に回す）
function rotateWeighted(cur, count, weights, pivot, quat) {
  for (let i = 0; i < count; i++) {
    const w = weights[i];
    if (w < 1e-3) continue;
    _vec.set(cur[i * 3] - pivot.x, cur[i * 3 + 1] - pivot.y, cur[i * 3 + 2] - pivot.z).applyQuaternion(quat);
    cur[i * 3] += w * (pivot.x + _vec.x - cur[i * 3]);
    cur[i * 3 + 1] += w * (pivot.y + _vec.y - cur[i * 3 + 1]);
    cur[i * 3 + 2] += w * (pivot.z + _vec.z - cur[i * 3 + 2]);
  }
}

export async function loadFigure(gender, color) {
  return new Figure(await loadDataset(), gender, color);
}
