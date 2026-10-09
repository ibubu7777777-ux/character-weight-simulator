// 身長・性別・筋肉量・体脂肪率から、体重やBMIなどを求める（画面や3Dには依存しない）。

// 創作キャラクター（小人・巨人など）も想定して、身長は 50〜300cm まで入力できる
export const RANGES = {
  male: { height: [50, 300], muscle: [15, 100], bodyFat: [6, 40], defaultHeight: 172 },
  female: { height: [50, 300], muscle: [15, 100], bodyFat: [14, 48], defaultHeight: 158 },
};
// 実在の人間の標準的な身長の範囲。これを外れると、体重は拡大・縮小した体型の目安になる
export const HUMAN_HEIGHT = [130, 220];

// 筋肉量スライダー(%) → FFMI（除脂肪量指数）。50 が標準的な体格。
const FFMI_POINTS = {
  male: [[0, 16], [50, 19], [100, 25]],
  female: [[0, 13.5], [50, 15.8], [100, 21]],
};

// 体脂肪率(%) → MakeHuman の体重軸(0〜1)。0.5 が標準的な体脂肪率。
const FAT_POINTS = {
  male: [[8, 0], [18, 0.5], [38, 1]],
  female: [[16, 0], [27, 0.5], [45, 1]],
};

export const PRESETS = {
  male: [
    { name: "痩せ型", muscle: 30, bodyFat: 12 },
    { name: "標準", muscle: 50, bodyFat: 18 },
    { name: "細マッチョ", muscle: 68, bodyFat: 12 },
    { name: "アスリート", muscle: 80, bodyFat: 11 },
    { name: "ゴリマッチョ", muscle: 95, bodyFat: 10 },
    { name: "ぽっちゃり", muscle: 50, bodyFat: 28 },
    { name: "肥満", muscle: 55, bodyFat: 36 },
  ],
  female: [
    { name: "痩せ型", muscle: 30, bodyFat: 20 },
    { name: "標準", muscle: 50, bodyFat: 27 },
    { name: "引き締まった", muscle: 68, bodyFat: 20 },
    { name: "アスリート", muscle: 80, bodyFat: 17 },
    { name: "筋肉質", muscle: 95, bodyFat: 16 },
    { name: "ぽっちゃり", muscle: 50, bodyFat: 36 },
    { name: "肥満", muscle: 55, bodyFat: 44 },
  ],
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 折れ線で補間する
function interpolate(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

// 除脂肪量(kg) = (FFMI − 6.1×(1.8−身長m)) × 身長m²
export function leanMassKg(gender, heightCm, muscle) {
  const h = heightCm / 100;
  const ffmi = interpolate(FFMI_POINTS[gender], muscle);
  return (ffmi - 6.1 * (1.8 - h)) * h * h;
}

export function bmiCategory(bmi) {
  if (bmi < 18.5) return "低体重";
  if (bmi < 25) return "普通体重";
  if (bmi < 30) return "肥満（1度）";
  if (bmi < 35) return "肥満（2度）";
  if (bmi < 40) return "肥満（3度）";
  return "肥満（4度）";
}

const MUSCLE_TEXT = [
  [30, "筋肉は少なく、細身で華奢な印象。"],
  [45, "筋肉は控えめで、すらりとした印象。"],
  [60, "筋肉量は標準的で、日常生活で自然につく程度。"],
  [75, "適度に鍛えられていて、引き締まった印象。"],
  [90, "しっかり鍛えられ、肩や腕に厚みがある。"],
  [Infinity, "非常に筋肉質で、競技者や格闘家のような体格。"],
];

// 女性は体脂肪率が高めなので、判定用に 8% 引いて男性と同じ基準で見る
const FAT_TEXT = [
  [9, "脂肪は極めて少なく、筋や血管が浮き出る。"],
  [14, "脂肪が少なく、シャープな輪郭。"],
  [20, "脂肪は標準的で、健康的な体つき。"],
  [26, "やや脂肪がつき、柔らかな輪郭。"],
  [32, "ぽっちゃりしていて、お腹まわりに脂肪がある。"],
  [Infinity, "体脂肪がかなり多く、全体的に丸みが強い。"],
];

const pick = (table, v) => table.find(([limit]) => v < limit)[1];

// 入力から全ての結果を計算する。weightKg を渡すと、体脂肪率を逆算する。
export function calculate({ gender, heightCm, muscle, bodyFat, weightKg = null }) {
  const range = RANGES[gender];
  const h = heightCm / 100;
  const notes = [];
  const muscleIn = muscle;

  let fatPercent = bodyFat;
  let impossible = false;
  if (weightKg != null) {
    // 体重 = 除脂肪量 ÷ (1 − 体脂肪率)。体脂肪率には下限・上限があるので、指定した体重がその範囲に収まらないときは、
    // 体脂肪率を下限（上限）にして、足りない分を筋肉量で合わせる。筋肉量は整数にそろえ、端数は体脂肪率で吸収する。
    const [fatMin, fatMax] = range.bodyFat;
    const wantedFirst = (1 - leanMassKg(gender, heightCm, muscle) / weightKg) * 100;
    if (wantedFirst < fatMin) {
      const target = weightKg * (1 - fatMin / 100); // 軽すぎる: 筋肉量を減らす
      let m = Math.floor(muscle);
      while (m > range.muscle[0] && leanMassKg(gender, heightCm, m) > target) m--;
      muscle = Math.max(range.muscle[0], m);
    } else if (wantedFirst > fatMax) {
      const target = weightKg * (1 - fatMax / 100); // 重すぎる: 筋肉量を増やす
      let m = Math.ceil(muscle);
      while (m < range.muscle[1] && leanMassKg(gender, heightCm, m) < target) m++;
      muscle = Math.min(range.muscle[1], m);
    }
    const wanted = (1 - leanMassKg(gender, heightCm, muscle) / weightKg) * 100;
    fatPercent = clamp(wanted, fatMin, fatMax);
    impossible = Math.abs(wanted - fatPercent) > 0.05;
    if (muscle !== muscleIn) notes.push(`指定した体重に合わせて、筋肉量を${Math.round(muscle)}%に調整しました。`);
  }
  const lean = leanMassKg(gender, heightCm, muscle);

  if (heightCm < HUMAN_HEIGHT[0] || heightCm > HUMAN_HEIGHT[1]) {
    notes.push(
      `人間の標準的な身長（${HUMAN_HEIGHT[0]}〜${HUMAN_HEIGHT[1]}cm）の範囲外です。体重とBMIは、人間の体型を拡大・縮小した場合の目安です。`
    );
  }

  const weight = lean / (1 - fatPercent / 100);
  if (impossible) {
    notes.push(
      `指定した体重は、この身長で作れる範囲（筋肉量${range.muscle[0]}〜${range.muscle[1]}%、体脂肪率${range.bodyFat[0]}〜${range.bodyFat[1]}%）を外れているため、` +
        `${weight.toFixed(1)}kgにしました。`
    );
  }
  const bmi = weight / (h * h);
  const category = bmiCategory(bmi);
  if (bmi >= 25 && fatPercent < (gender === "male" ? 20 : 28)) {
    notes.push("筋肉が多いためBMIは高めですが、体脂肪は少なく、肥満ではありません。");
  }

  const fatAdjusted = gender === "male" ? fatPercent : fatPercent - 8;
  return {
    muscle, // 体重の指定に合わせて調整されることがある
    weight,
    bmi,
    category,
    bodyFat: fatPercent,
    fatMass: weight - lean,
    leanMass: lean,
    standardWeight: 22 * h * h,
    weightRange: [18.5 * h * h, 25 * h * h],
    description: `${pick(MUSCLE_TEXT, muscle)}${pick(FAT_TEXT, fatAdjusted)}`,
    notes,
    // 3D 用: 0.5 が標準
    shape: {
      muscle: clamp(muscle / 100, 0, 1),
      weight: interpolate(FAT_POINTS[gender], fatPercent),
    },
  };
}
