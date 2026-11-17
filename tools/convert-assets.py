"""把景物原图转换为资源包规范要求的图片。

用法：
    python tools/convert-assets.py --src design/design_no.2/assets --out miniprogram/packs/baimasi
    python tools/convert-assets.py            # 等价于上面这条默认路径

映射来源（按优先级）：
    1. --map 指定的 JSON；
    2. <src>/sources.json（若存在）；
    3. 按 pack.json 反推约定名：
       cover.jpg             ← cover.jpg / cover.png
       01-shanmen.jpg        ← scene-shanmen.jpg
       narrator/wu-default.png ← narrator-default.png
       narrator/wu-default.jpg ← narrator-default.jpg（生成包整包共用的人物插画）
       narrator/shanmen.jpg  ← portrait-shanmen.jpg（旧包按幕人物插画）

格式：封面与分镜输出 JPG，立绘输出 PNG（保留透明底）。
真机 `<image>` 默认不解析 WebP，因此不再输出 webp。

规格：封面 3:4 900×1200 ≤200KB；分镜 9:16 宽 1080 ≤400KB；
立绘透明底宽 600–900 ≤150KB；人物插画 3:4 宽 600 ≤90KB。
"""

import argparse
import json
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(ROOT, "design", "design_no.2", "assets")
DEFAULT_OUT = os.path.join(ROOT, "miniprogram", "packs", "baimasi")

EXT_ORDER = (".jpg", ".jpeg", ".png", ".webp")

KINDS = {
    "cover": {"fit": (3, 4), "width": 900, "quality": 78, "mode": "RGB", "ext": ".jpg"},
    "scene": {"fit": (9, 16), "width": 1080, "quality": 60, "mode": "RGB", "ext": ".jpg"},
    "narrator": {"width": 640, "quality": 0, "mode": "RGBA", "ext": ".png"},
    # 每幕人物插画：3:4 竖幅 JPG，体积按 90KB 封顶
    "portrait": {"fit": (3, 4), "width": 600, "quality": 68, "mode": "RGB", "ext": ".jpg"},
}


def fit_cover(im, ratio_w, ratio_h):
    """按目标比例中心裁切，避免拉伸。"""
    w, h = im.size
    target = ratio_w / ratio_h
    if w / h > target:
        nw = int(h * target)
        left = (w - nw) // 2
        return im.crop((left, 0, left + nw, h))
    nh = int(w / target)
    top = (h - nh) // 2
    return im.crop((0, top, w, top + nh))


def resize_width(im, min_w, allow_upscale=False):
    """默认不放大；分镜必须达到 1080 宽才能通过校验，允许小幅放大。"""
    w, h = im.size
    if w > min_w or (allow_upscale and w < min_w):
        return im.resize((min_w, int(round(h * min_w / w))), Image.LANCZOS)
    return im


def save_image(im, path, kind, quality):
    """封面/分镜存 JPG，立绘存带透明底的 PNG（256 色量化控制体积）。"""
    spec = KINDS[kind]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if spec["ext"] == ".jpg":
        im.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    else:
        im.quantize(colors=256, method=Image.FASTOCTREE).save(path, "PNG", optimize=True)
    return os.path.getsize(path)


def base_name(rel):
    return os.path.splitext(os.path.basename(rel))[0]


def strip_index(name):
    """01-shanmen → shanmen"""
    head, _, tail = name.partition("-")
    return tail if head.isdigit() and tail else name


def resolve(src_dir, value):
    """把映射值解析为实际文件：允许省略扩展名。"""
    if not value:
        return None
    direct = os.path.join(src_dir, value)
    if os.path.exists(direct):
        return direct
    if not os.path.splitext(value)[1]:
        for ext in EXT_ORDER:
            candidate = os.path.join(src_dir, value + ext)
            if os.path.exists(candidate):
                return candidate
    return None


def kind_of(out_rel, cover_rel):
    if out_rel == cover_rel:
        return "cover"
    if out_rel.startswith("narrator/"):
        return "narrator"
    return "scene"


def build_jobs(src_dir, pack, mapping):
    cover_rel = pack.get("cover", "")
    jobs = []

    if cover_rel:
        src = mapping.get(cover_rel) or "cover"
        jobs.append((cover_rel, resolve(src_dir, src), "cover"))

    for scene in pack.get("scenes") or []:
        image = scene.get("image")
        if not image:
            continue
        src = mapping.get(image) or ("scene-" + strip_index(base_name(image)))
        jobs.append((image, resolve(src_dir, src), kind_of(image, cover_rel)))

        portrait = scene.get("portrait")
        if portrait:
            src = mapping.get(portrait) or ("portrait-" + scene.get("id", ""))
            jobs.append((portrait, resolve(src_dir, src), "portrait"))

    narrator = pack.get("narrator") or {}
    for pose, out_rel in (narrator.get("portraits") or {}).items():
        src = mapping.get(out_rel) or ("narrator-" + pose)
        # 全局立绘：透明抠图走 PNG 立绘规格，不透明生成插画走 3:4 JPG 规格
        kind = "portrait" if out_rel.lower().endswith((".jpg", ".jpeg")) else "narrator"
        jobs.append((out_rel, resolve(src_dir, src), kind))

    return jobs


def open_image(src_path, mode):
    """转 RGB 前先把透明像素铺到主题底色，避免直接丢弃 alpha 变成黑边。"""
    im = Image.open(src_path)
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    if mode == "RGB" and has_alpha:
        rgba = im.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (22, 19, 15))  # 与 pack theme.bg #16130F 一致
        bg.paste(rgba, mask=rgba.split()[-1])
        return bg
    return im.convert(mode)


def convert(src_path, out_path, kind, quality, max_kb=0, min_quality=25):
    spec = KINDS[kind]
    im = open_image(src_path, spec["mode"])
    if spec.get("fit"):
        im = fit_cover(im, *spec["fit"])
    if kind == "cover":
        im = im.resize((900, 1200), Image.LANCZOS)
    else:
        im = resize_width(im, spec["width"], allow_upscale=(kind == "scene"))
    size = save_image(im, out_path, kind, quality)
    # 人物插画固定按 90KB 封顶，与生成端的整包预算一致
    limit = 90 if kind == "portrait" else max_kb
    while limit and kind != "narrator" and size > limit * 1024 and quality > min_quality:
        quality -= 5
        size = save_image(im, out_path, kind, quality)
    return im.size, size, quality


def main():
    parser = argparse.ArgumentParser(description="景物原图 → 资源包图片（JPG / PNG）")
    parser.add_argument("--src", default=DEFAULT_SRC, help="原图目录")
    parser.add_argument("--out", default=DEFAULT_OUT, help="资源包目录")
    parser.add_argument("--map", default=None, help="映射 JSON：包内路径 → 源文件名")
    parser.add_argument("--cover-quality", type=int, default=KINDS["cover"]["quality"], help="封面 JPEG 质量")
    parser.add_argument("--scene-quality", type=int, default=KINDS["scene"]["quality"], help="分镜 JPEG 起始质量")
    parser.add_argument("--scene-max-kb", type=int, default=0, help="分镜体积上限，超出则逐步降质")
    parser.add_argument("--scene-min-quality", type=int, default=25, help="分镜降质下限，默认 25")
    args = parser.parse_args()

    pack_path = os.path.join(args.out, "pack.json")
    if not os.path.exists(pack_path):
        raise SystemExit("找不到 pack.json：先写出资源包描述再转换素材")

    with open(pack_path, encoding="utf-8") as f:
        pack = json.load(f)

    map_path = args.map or os.path.join(args.src, "sources.json")
    mapping = {}
    if os.path.exists(map_path):
        with open(map_path, encoding="utf-8") as f:
            mapping = json.load(f)

    jobs = build_jobs(args.src, pack, mapping)
    missing = 0
    for out_rel, src_path, kind in jobs:
        target = os.path.join(args.out, out_rel)
        if not src_path:
            print("[跳过] %s：未找到源图" % out_rel)
            missing += 1
            continue
        if kind == "cover":
            quality = args.cover_quality
            # 封面固定 900×1200，校验上限 200KB：真实照片按默认质量容易超标，这里降质兜底
            limit_kb = 200
        elif kind == "portrait":
            quality = KINDS["portrait"]["quality"]
            limit_kb = args.scene_max_kb
        else:
            quality = args.scene_quality
            limit_kb = args.scene_max_kb
        size, bytes_, quality = convert(
            src_path, target, kind, quality, limit_kb, args.scene_min_quality
        )
        print(
            "%-30s %s q%d %dKB"
            % (out_rel, "%dx%d" % size, quality, bytes_ // 1024)
        )

    print("完成：%d 个文件，%d 个缺失" % (len(jobs) - missing, missing))
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
