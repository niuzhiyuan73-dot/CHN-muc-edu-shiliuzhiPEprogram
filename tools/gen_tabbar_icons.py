"""
生成 tabBar 图标（P1 美学改造）
============================================================
微信 tabBar 只接受本地 PNG（不支持 SVG / 网络图）。本脚本用 Pillow
以高分辨率绘制线条图标后缩小到 81x81，保证边缘平滑。

产物（miniprogram/assets/tabbar/）：
  home.png / home-active.png        首页：小房子
  assoc.png / assoc-active.png      协会：双人（人群）
  profile.png / profile-active.png  我的：单人

灰色 = 未选中（#8A8F99），石榴红 = 选中（#B23A2E）。
改配色或形状后重跑本脚本即可再生成。
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parents[1] / "miniprogram" / "assets" / "tabbar"

SIZE = 324  # 画布尺寸，缩到 81 后线条平滑
GRAY = (138, 143, 153, 255)  # app.json tabBar.color
RED = (178, 58, 46, 255)     # app.json tabBar.selectedColor


def render(draw_fn, color) -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(img), color)
    return img.resize((81, 81), Image.LANCZOS)


def save(img: Image.Image, name: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img.save(OUT_DIR / name)
    print("wrote", OUT_DIR / name)


def draw_home(d, color) -> None:
    w = 22
    # 屋顶：人字形两条线
    d.line([(52, 152), (162, 58)], fill=color, width=w)
    d.line([(162, 58), (272, 152)], fill=color, width=w)
    # 房身：左右墙 + 地面
    d.line([(78, 132), (78, 262)], fill=color, width=w)
    d.line([(246, 132), (246, 262)], fill=color, width=w)
    d.line([(78, 262), (246, 262)], fill=color, width=w)
    # 门
    d.rounded_rectangle([(136, 186), (188, 262)], radius=14, outline=color, width=w - 6)


def draw_assoc(d, color) -> None:
    w = 20
    # 后面的人（左）：头 + 肩弧
    d.ellipse([(56, 84), (128, 156)], outline=color, width=w)
    d.arc([(40, 162), (152, 286)], start=180, end=360, fill=color, width=w)
    # 前面的人（右）：头 + 肩弧
    d.ellipse([(160, 118), (244, 202)], outline=color, width=w)
    d.arc([(140, 208), (272, 330)], start=180, end=360, fill=color, width=w)


def draw_profile(d, color) -> None:
    w = 22
    # 头
    d.ellipse([(116, 52), (208, 144)], outline=color, width=w)
    # 肩弧（半圆）
    d.arc([(74, 158), (250, 322)], start=180, end=360, fill=color, width=w)


def main() -> None:
    for base, draw_fn in (("home", draw_home), ("assoc", draw_assoc), ("profile", draw_profile)):
        save(render(draw_fn, GRAY), f"{base}.png")
        save(render(draw_fn, RED), f"{base}-active.png")


if __name__ == "__main__":
    main()
