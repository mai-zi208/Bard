"""生成主包内的资源包封面缩略图。

内置资源包已拆成分包（packs/{id}），列表页不能直接引用分包内封面，
否则进入列表就会下载全部分包。这里把每个包的 cover.jpg 缩成 3:4 竖图，
输出到 miniprogram/covers/{id}.jpg，供资源包列表与欢迎页使用。

用法：
    python tools/build-covers.py
    python tools/build-covers.py --packs miniprogram/packs --out miniprogram/covers

规格：3:4 竖图，宽 600，单张 ≤80KB（超出逐步降质）。
"""

import argparse
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PACKS = os.path.join(ROOT, "miniprogram", "packs")
DEFAULT_OUT = os.path.join(ROOT, "miniprogram", "covers")

WIDTH = 600
RATIO = (3, 4)
MAX_KB = 80
QUALITY = 78


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


def build_cover(src, out_path):
    im = Image.open(src).convert("RGB")
    im = fit_cover(im, *RATIO)
    height = int(round(WIDTH * RATIO[1] / RATIO[0]))
    im = im.resize((WIDTH, height), Image.LANCZOS)

    quality = QUALITY
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    im.save(out_path, "JPEG", quality=quality, optimize=True, progressive=True)
    size = os.path.getsize(out_path)
    while size > MAX_KB * 1024 and quality > 25:
        quality -= 5
        im.save(out_path, "JPEG", quality=quality, optimize=True, progressive=True)
        size = os.path.getsize(out_path)
    return quality, size


def main():
    parser = argparse.ArgumentParser(description="内置资源包封面缩略图")
    parser.add_argument("--packs", default=DEFAULT_PACKS, help="资源包目录")
    parser.add_argument("--out", default=DEFAULT_OUT, help="缩略图输出目录")
    args = parser.parse_args()

    total = 0
    for name in sorted(os.listdir(args.packs)):
        pack_dir = os.path.join(args.packs, name)
        if not os.path.isdir(pack_dir) or not os.path.exists(os.path.join(pack_dir, "pack.json")):
            continue
        src = os.path.join(pack_dir, "cover.jpg")
        if not os.path.exists(src):
            print("[跳过] %s：缺少 cover.jpg" % name)
            continue
        target = os.path.join(args.out, name + ".jpg")
        quality, size = build_cover(src, target)
        total += size
        print("%-24s q%d %dKB" % (name, quality, size // 1024))

    print("完成：%d 张封面，合计 %dKB" % (len(os.listdir(args.out)), total // 1024))


if __name__ == "__main__":
    raise SystemExit(main())
