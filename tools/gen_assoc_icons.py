"""
生成协会运动图标（P2 美学改造）
============================================================
为各协会生成白色线条运动图标 PNG，放在协会主题色的渐变圆底上使用
（协会选择页 assoc-btn-glyph、工作台 ws-head-glyph）。

产物（miniprogram/assets/assoc/）：
  pkb.png  匹克球：拍面 + 短柄 + 球
  tt.png   乒乓球：圆拍 + 短柄 + 球
  bd.png   羽毛球：球拍 + 球
  tn.png   网球：椭圆拍面 + 斜长柄 + 球
  bk.png   篮球：球面缝线
  fb.png   足球：中央五边形 + 球面拼接线

图标一律白色（#FFFFFF）线条 + 透明底——颜色由底座（渐变）提供，
新增协会时在 ICONS 里加一个绘制函数即可。
"""

from pathlib import Path
import math

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parents[1] / "miniprogram" / "assets" / "assoc"

SIZE = 288  # 画布；显示处约 88rpx（44px），高分辨率缩小保证平滑
WHITE = (255, 255, 255, 255)


def render(draw_fn) -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(img))
    return img.resize((144, 144), Image.LANCZOS)


def save(img: Image.Image, name: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img.save(OUT_DIR / name)
    print("wrote", OUT_DIR / name)


def draw_pkb(d) -> None:
    """匹克球：方圆拍面 + 短柄 + 带孔的球"""
    w = 18
    # 拍面：近方圆形（匹克球拍比乒乓拍大且方）
    d.rounded_rectangle([(58, 36), (198, 176)], radius=44, outline=WHITE, width=w)
    # 柄
    d.rounded_rectangle([(112, 170), (144, 246)], radius=10, outline=WHITE, width=w - 4)
    # 球（右侧下方），带三个小孔
    d.ellipse([(196, 186), (268, 258)], outline=WHITE, width=w)
    for hx, hy in ((222, 210), (238, 226), (222, 238)):
        d.ellipse([(hx, hy), (hx + 10, hy + 10)], fill=WHITE)


def draw_tt(d) -> None:
    """乒乓球：圆形拍面 + 竖直短柄 + 右上小球（横置柄会误读成放大镜）"""
    w = 18
    # 拍面：正圆
    d.ellipse([(60, 36), (208, 184)], outline=WHITE, width=w)
    # 柄：竖直向下
    d.rounded_rectangle([(116, 178), (152, 252)], radius=10, outline=WHITE, width=w - 4)
    # 球：右上，明显离开拍面
    d.ellipse([(214, 60), (266, 112)], outline=WHITE, width=w)


def draw_bd(d) -> None:
    """羽毛球：单个羽毛球（裙边扇形 + 球头），比「拍+球」组合更易识别"""
    w = 16
    # 裙边：顶部圆弧 + 两侧斜线收拢到球头
    d.arc([(92, 28), (216, 152)], start=180, end=360, fill=WHITE, width=w)
    d.line([(96, 90), (138, 216)], fill=WHITE, width=w)
    d.line([(212, 90), (170, 216)], fill=WHITE, width=w)
    # 裙内两根羽毛线
    d.line([(128, 66), (146, 200)], fill=WHITE, width=w - 6)
    d.line([(180, 66), (162, 200)], fill=WHITE, width=w - 6)
    # 球头：底部小圆
    d.ellipse([(132, 208), (176, 252)], outline=WHITE, width=w)


def draw_tn(d) -> None:
    """网球：细长椭圆拍面 + 斜长柄 + 带缝线的球（不画网线，否则像放大镜）"""
    w = 16
    # 拍面：细长竖向椭圆（网球拍比乒乓拍更长、更窄）
    d.ellipse([(44, 18), (172, 178)], outline=WHITE, width=w)
    # 柄：从拍面右下斜向右下，长度明显大于乒乓拍
    d.line([(152, 158), (240, 236)], fill=WHITE, width=w + 6)
    # 球：右上，两条对称缝线
    d.ellipse([(198, 30), (272, 104)], outline=WHITE, width=w - 2)
    d.arc([(202, 34), (256, 88)], start=120, end=240, fill=WHITE, width=8)
    d.arc([(214, 46), (268, 100)], start=300, end=60, fill=WHITE, width=8)


def draw_bk(d) -> None:
    """篮球：正圆球体 + 横缝 + 竖缝 + 左右两道弧线

    弧线的包围盒比球体窄（x 从 60 到 228，球是 40–248），弧的两端正好落在
    竖直中缝的上下极点，所以只会在球**内部**鼓出，不会像上一版那样溢出成
    「球外挂着两片」。PIL 的 arc 从 start 顺时针画到 end：
      start=90 → end=270 经过 180（左侧），是左弧；
      start=270 → end=90 经过 0（右侧），是右弧。
    """
    w = 16
    d.ellipse([(40, 40), (248, 248)], outline=WHITE, width=w)
    d.line([(40, 144), (248, 144)], fill=WHITE, width=w)
    d.line([(144, 40), (144, 248)], fill=WHITE, width=w)
    # 弧线包围盒收窄到 84–204（球是 40–248）：弧的中段距外圈约 44px，
    # 读起来是「球面上的缝」，而不是贴着外圈的第二个圆（上一版就是因此
    # 看着像网球）。
    d.arc([(84, 40), (204, 248)], start=90, end=270, fill=WHITE, width=w - 2)
    d.arc([(84, 40), (204, 248)], start=270, end=90, fill=WHITE, width=w - 2)


def draw_fb(d) -> None:
    """足球：球面外圈、中央五边形及五道拼接线，与已有白色线条图标一致。"""
    w = 14
    d.ellipse([(40, 40), (248, 248)], outline=WHITE, width=16)
    angles = [-math.pi / 2 + i * 2 * math.pi / 5 for i in range(5)]
    inner = [(round(144 + 47 * math.cos(a)), round(144 + 47 * math.sin(a))) for a in angles]
    d.line(inner + [inner[0]], fill=WHITE, width=w, joint="curve")
    for point, angle in zip(inner, angles):
        outer = (round(144 + 99 * math.cos(angle)), round(144 + 99 * math.sin(angle)))
        d.line([point, outer], fill=WHITE, width=w)


def main() -> None:
    for name, draw_fn in (
        ("pkb", draw_pkb), ("tt", draw_tt), ("bd", draw_bd), ("tn", draw_tn), ("bk", draw_bk), ("fb", draw_fb),
    ):
        save(render(draw_fn), f"{name}.png")


if __name__ == "__main__":
    main()
