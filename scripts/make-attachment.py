# 데모 시나리오 2번의 「파손된 접시」 첨부 사진(그림)을 그려 public/attachments 에 저장한다
import math, random
from PIL import Image, ImageDraw, ImageFilter

random.seed(7)
W, H = 960, 720
img = Image.new("RGB", (W, H), (176, 132, 86))
d = ImageDraw.Draw(img)
# box flaps / inner walls
d.polygon([(0, 0), (W, 0), (W - 90, 80), (90, 80)], fill=(150, 108, 66))
d.polygon([(0, H), (W, H), (W - 90, H - 80), (90, H - 80)], fill=(196, 152, 104))
d.polygon([(0, 0), (90, 80), (90, H - 80), (0, H)], fill=(160, 117, 74))
d.polygon([(W, 0), (W - 90, 80), (W - 90, H - 80), (W, H)], fill=(168, 124, 80))
# crumpled packing paper
for _ in range(70):
    x, y = random.randint(100, W - 100), random.randint(90, H - 90)
    r = random.randint(30, 70)
    shade = random.randint(215, 238)
    d.ellipse([x - r, y - r * 0.7, x + r, y + r * 0.7], fill=(shade, shade - 4, shade - 14), outline=(190, 185, 170))
cx, cy, R = W // 2, H // 2 + 10, 250
def rim_points(a0, a1, rad, n=80):
    return [(cx + rad * math.cos(math.radians(a)), cy + 0.62 * rad * math.sin(math.radians(a))) for a in [a0 + (a1 - a0) * i / n for i in range(n + 1)]]
# jagged crack line across the platter
crack = []
for i in range(13):
    t = i / 12
    x = cx - R * 1.05 + 2.1 * R * t
    y = cy - 70 + 140 * t + random.randint(-22, 22)
    crack.append((x, y))
glaze, rimc, inner = (122, 140, 124), (92, 108, 95), (140, 158, 140)
# left/top half, shifted up-left
def half(points_rim, shift, crack_pts):
    poly = [(x + shift[0], y + shift[1]) for x, y in points_rim + crack_pts]
    return poly
top = rim_points(200, 340, R)
bot = rim_points(20, 160, R)
shadow = Image.new("L", (W, H), 0)
sd = ImageDraw.Draw(shadow)
sd.polygon(half(rim_points(150, 360, R) , (14, 22), list(reversed(crack))), fill=110)
sd.polygon(half(rim_points(-20, 200, R), (34, 40), crack), fill=110)
shadow = shadow.filter(ImageFilter.GaussianBlur(14))
img.paste((60, 40, 25), (0, 0), shadow)
p1 = half(rim_points(165, 345, R), (-12, -14), list(reversed(crack)))
p2 = half(rim_points(-15, 165, R), (16, 18), crack)
for poly in (p1, p2):
    d.polygon(poly, fill=glaze, outline=rimc)
    d.line(poly + [poly[0]], fill=rimc, width=6)
# inner well
for poly, sh in ((rim_points(170, 340, R * 0.72), (-12, -14)), (rim_points(-10, 160, R * 0.72), (16, 18))):
    d.line([(x + sh[0], y + sh[1]) for x, y in poly], fill=inner, width=4)
# exposed clay edge along crack
d.line([(x - 12, y - 14) for x, y in crack], fill=(214, 196, 170), width=5)
d.line([(x + 16, y + 18) for x, y in crack], fill=(214, 196, 170), width=5)
# shards
for _ in range(9):
    x, y = cx + random.randint(-200, 200), cy + random.randint(-40, 120)
    s = random.randint(10, 26)
    d.polygon([(x, y), (x + s, y + s // 3), (x + s // 2, y + s)], fill=glaze, outline=(214, 196, 170))
img = img.filter(ImageFilter.SMOOTH)
img.save("public/attachments/platter-damage.png", optimize=True)
print("saved", img.size)
