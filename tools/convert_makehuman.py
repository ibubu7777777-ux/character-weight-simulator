"""MakeHuman の素体メッシュと体型ターゲットを、Web 用のバイナリに変換する。

入力 : MakeHuman リポジトリの makehuman/data (CC0)
出力 : <out>/<gender>.bin, <out>/arms.bin, <out>/meta.json

<gender>.bin の並び（すべてリトルエンディアン）
  positions : float32 * (nPoints*3)        素体の頂点座標
  indices   : uint32  * (nTris*3)          三角形の頂点番号
  deltas    : float32 * (nTargets*nPoints*3) 各ターゲットの頂点移動量
              並びは [アジア系の基本形状1つ, 筋肉3×体重3 の9つ] + 女性のみ [胸が最小, 胸が最大]
  nPoints = nVerts + 関節の数。末尾の「関節の点」は体と同じ変形を受ける
  （三角形には使わない）。meta.json の points に、名前 → 頂点番号 の対応を書く。
  肩・肘・股関節・膝・指の付け根は、腕や脚、指を回すときの支点。目は目線の位置に使う。

arms.bin
  体の頂点ごとの重み（0〜255 を 0〜1 とみなす uint8）を、nVerts 個ずつ並べたもの。
  並びと名前は meta.json の weightArrays に書く（腕全体、前腕〜手、脚、各指）。

使い方: python convert_makehuman.py <makehuman/data のパス> <出力フォルダ>
"""
import array
import json
import sys
from pathlib import Path

AGES = ["young"]  # 年齢は扱わない（成人 young のみ）
MUSCLES = ["minmuscle", "averagemuscle", "maxmuscle"]
WEIGHTS = ["minweight", "averageweight", "maxweight"]
RACES = ["asian"]  # 日本人キャラ想定のためアジア系のみ
GENDERS = ["female", "male"]
SIDES = ("L", "R")

# 胸が最大のときの持ち上げ具合（0〜1）
BUST_LIFT_VOLUME = 0.7
BUST_LIFT_POSITION = 0.4

ARM_BONES = ("upperarm", "lowerarm", "wrist", "metacarpal", "finger")
FOREARM_BONES = ("lowerarm", "wrist", "metacarpal", "finger")
LEG_BONES = ("upperleg", "lowerleg", "foot", "toe")


def point_names():
    """(名前, 骨格データ上の関節名) の一覧。"""
    names = []
    for side in SIDES:
        names += [
            (f"shoulder{side}", f"upperarm01.{side}____head"),
            (f"elbow{side}", f"lowerarm01.{side}____head"),
            (f"wrist{side}", f"wrist.{side}____head"),
            (f"eye{side}", f"eye.{side}____head"),
            (f"hip{side}", f"upperleg01.{side}____head"),
            (f"knee{side}", f"lowerleg01.{side}____head"),
            (f"ankle{side}", f"foot.{side}____head"),
        ]
        for n in range(1, 6):  # 親指(1)〜小指(5)
            names += [
                (f"finger{n}Base{side}", f"finger{n}-1.{side}____head"),
                (f"finger{n}Tip{side}", f"finger{n}-3.{side}____tail"),
            ]
    return names


def weight_arrays():
    """(名前, 左右, 骨の名前の接頭辞) の一覧。"""
    arrays = []
    for side in SIDES:
        arrays += [
            (f"arm{side}", side, ARM_BONES),
            (f"fore{side}", side, FOREARM_BONES),
            (f"leg{side}", side, LEG_BONES),
        ]
        arrays += [(f"finger{n}{side}", side, (f"finger{n}-",)) for n in range(1, 6)]
    return arrays


def read_body_mesh(obj_path):
    """base.obj の 'body' グループだけを読み、使われる頂点に詰め直す。"""
    verts, faces, group = [], [], None
    for line in obj_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("v "):
            verts.append(tuple(float(x) for x in line.split()[1:4]))
        elif line.startswith("g "):
            group = line.split()[1]
        elif line.startswith("f ") and group == "body":
            idx = [int(tok.split("/")[0]) - 1 for tok in line.split()[1:]]
            for i in range(1, len(idx) - 1):  # 四角形も三角形に分割
                faces.append((idx[0], idx[i], idx[i + 1]))
    used = sorted({i for f in faces for i in f})
    remap = {old: new for new, old in enumerate(used)}
    positions = [verts[i] for i in used]
    tris = [tuple(remap[i] for i in f) for f in faces]
    return verts, positions, tris, remap


def parse_target(path):
    """.target (疎な頂点移動量) を {元の頂点番号: (dx, dy, dz)} にする。"""
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        i, x, y, z = line.split()
        out[int(i)] = (float(x), float(y), float(z))
    return out


def dense_delta(target, remap, n_points, joints):
    """体の頂点＋関節の点の、密な移動量配列にする。"""
    delta = array.array("f", [0.0]) * (n_points * 3)
    for old, d in target.items():
        new = remap.get(old)
        if new is not None:
            delta[new * 3:new * 3 + 3] = array.array("f", d)
    base = (n_points - len(joints)) * 3
    for k, indices in enumerate(joints):
        moves = [target.get(i, (0.0, 0.0, 0.0)) for i in indices]
        c = [sum(m[a] for m in moves) / len(moves) for a in range(3)]
        delta[base + k * 3:base + k * 3 + 3] = array.array("f", c)
    return delta


def bone_weights(skin, remap, n_verts, side, prefixes):
    """指定した骨（左右どちらか）への重みの合計を、0〜255 の uint8 にする。"""
    arr = [0.0] * n_verts
    for bone, entries in skin.items():
        if bone.endswith("." + side) and bone.startswith(prefixes):
            for old, w in entries:
                new = remap.get(old)
                if new is not None:
                    arr[new] += w
    return bytes(min(255, round(w * 255)) for w in arr)


def main(data_dir, out_dir):
    data, out = Path(data_dir), Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    all_verts, positions, tris, remap = read_body_mesh(data / "3dobjs" / "base.obj")
    n_verts = len(positions)

    skeleton = json.loads((data / "rigs" / "default.mhskel").read_text(encoding="utf-8"))
    names = point_names()
    joints = [skeleton["joints"][joint] for _, joint in names]
    n_points = n_verts + len(joints)

    base_points = list(positions)
    for indices in joints:
        pts = [all_verts[i] for i in indices]
        base_points.append(tuple(sum(p[a] for p in pts) / len(pts) for a in range(3)))

    skin = json.loads((data / "rigs" / "default_weights.mhw").read_text(encoding="utf-8"))["weights"]
    arrays = weight_arrays()
    with open(out / "arms.bin", "wb") as f:
        for _, side, prefixes in arrays:
            f.write(bone_weights(skin, remap, n_verts, side, prefixes))

    meta = {
        "nVerts": n_verts,
        "nPoints": n_points,
        "nTris": len(tris),
        "points": {name: n_verts + i for i, (name, _) in enumerate(names)},
        "weightArrays": [name for name, _, _ in arrays],
        "ages": AGES,
        "races": RACES,
        "muscles": MUSCLES,
        "weights": WEIGHTS,
        "genders": GENDERS,
        "license": "CC0 1.0 (MakeHuman assets, 2020-09)",
    }
    macro = data / "targets" / "macrodetails"
    for gender in GENDERS:
        with open(out / f"{gender}.bin", "wb") as f:
            f.write(array.array("f", [c for p in base_points for c in p]).tobytes())
            f.write(array.array("I", [i for t in tris for i in t]).tobytes())
            for age in AGES:
                # 性別・年齢の基本形状（人種ごと）
                for race in RACES:
                    target = parse_target(macro / f"{race}-{gender}-{age}.target")
                    f.write(dense_delta(target, remap, n_points, joints).tobytes())
                for m in MUSCLES:
                    for w in WEIGHTS:
                        target = parse_target(macro / f"universal-{gender}-{age}-{m}-{w}.target")
                        f.write(dense_delta(target, remap, n_points, joints).tobytes())

    # 胸の大きさ（女性のみ）: 標準の筋肉・体重のときの、カップが最小・最大の形を、女性のファイルの最後に2つ足す。
    # 標準のカップ（中間）が、素体そのもの。大きい側は、張りが標準のままだと垂れて見えるので、
    # 張りが最大のものに、体積を上側へ寄せる調整と、位置を少し上げる調整を足して、持ち上げる。
    breast = macro.parent / "breast"
    prefix = "female-young-averagemuscle-averageweight"
    bust_recipes = [
        [(f"{prefix}-mincup-averagefirmness", 1.0)],
        [
            (f"{prefix}-maxcup-maxfirmness", 1.0),
            ("breast-volume-vert-up", BUST_LIFT_VOLUME),
            ("breast-trans-up", BUST_LIFT_POSITION),
        ],
    ]
    with open(out / "female.bin", "ab") as f:
        for recipe in bust_recipes:
            total = {}
            for name, weight in recipe:
                for i, d in parse_target(breast / f"{name}.target").items():
                    old = total.get(i, (0.0, 0.0, 0.0))
                    total[i] = tuple(old[a] + d[a] * weight for a in range(3))
            f.write(dense_delta(total, remap, n_points, joints).tobytes())
    meta["bustTargets"] = 2

    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"vertices={n_verts} points={len(joints)} triangles={len(tris)} weight arrays={len(arrays)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
