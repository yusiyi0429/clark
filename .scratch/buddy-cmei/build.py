# C妹 伙伴形象：从授权的原图（source/c-mei-sheet.webp，六格表情）一比一切出 rig 要的图层，拼成 cmeiArt.ts / cmei.svg。
# 用法：python3 .scratch/buddy-cmei/build.py [调试图输出目录]
# 依赖：Pillow、numpy、scipy、scikit-image（pip install pillow numpy scipy scikit-image）
#
# 取第 1 格（平时）当底图；第 2 格（张嘴）取说话的嘴；第 4 格（闭眼笑）取闭眼。
# 底图里把眼睛、嘴、手原来的地方补成皮肤和衣服（biharmonic 补洞），这样眨眼、说话、放手时不会露出原画。
# 眼睛拆三层：眼白（眼珠底下补成白）→ 眼珠（裁在眼眶里，rig 转眼时只移它）→ 睫毛和眼线（压在最上面）。
import base64, io, json, os, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage
from skimage import color, measure, registration, restoration

HERE = os.path.dirname(os.path.abspath(__file__))
DEBUG = sys.argv[1] if len(sys.argv) > 1 else None
SHEET = Image.open(os.path.join(HERE, "source", "c-mei-sheet.webp")).convert("RGB")

# 第 1 格在整张图里的范围：到边沿那条线（y 475）之上两行为止（那两行混着边沿线的灰），胶囊上沿取代它
P1 = (10, 26, 440, 473)
W, H = P1[2] - P1[0], P1[3] - P1[1]
# 放进 rig 坐标：每个像素 1.6 个单位；原图的边沿落在胶囊玻璃的上沿（约 868，两只手正好搭在上面），脸的中线落在 torsoCx 447
S = 1.6
OX, OY = 447 - 215 * S, 868 - H * S
EXT = 40  # 底图和手往边沿下面多补的像素：侧头、举手回弹时不露切口

def crop(box):
    return np.asarray(SHEET.crop(box)).astype(np.float64) / 255

def aligned(dx, dy):
    """第 1 格的位置挪 (dx, dy) 去取别的格子，再用相位相关微调到和第 1 格对齐。"""
    ref = color.rgb2gray(crop(P1))
    box = (P1[0] + dx, P1[1] + dy, P1[2] + dx, P1[3] + dy)
    img = crop(box)
    shift, _, _ = registration.phase_cross_correlation(ref, color.rgb2gray(img), upsample_factor=1)
    sy, sx = int(round(shift[0])), int(round(shift[1]))
    box = (box[0] - sx, box[1] - sy, box[2] - sx, box[3] - sy)
    return crop(box), (dx - sx, dy - sy)

p1 = crop(P1)
p2, off2 = aligned(426, 0)     # 第 2 格：张嘴
p4, off4 = aligned(0, 590)     # 第 4 格：闭眼笑
lab1 = color.rgb2lab(p1)
L, A, B = lab1[..., 0], lab1[..., 1], lab1[..., 2]
CH = np.hypot(A, B)
HUE = (np.degrees(np.arctan2(B, A)) + 360) % 360

# ── 背景：和边框连通的白色 → 透明；轮廓边上的半透明像素按「和白色混合」反解出颜色和透明度 ──
white = (L > 96) & (CH < 6)
lab_bg, _ = ndimage.label(white)
border = set(np.unique(np.concatenate([lab_bg[0], lab_bg[-1], lab_bg[:, 0], lab_bg[:, -1]]))) - {0}
bg = np.isin(lab_bg, list(border))
near = ndimage.binary_dilation(bg, iterations=2) & ~bg
alpha = np.where(bg, 0.0, 1.0)
# 边缘像素：alpha = 离白色多远（取 RGB 里最小的那个通道反推）
mn = p1.min(axis=2)
edge_a = np.clip((1 - mn) / 0.55, 0, 1)
alpha[near] = edge_a[near]

def unmix(rgb, a):
    out = rgb.copy()
    m = (a > 0.02) & (a < 0.999)
    out[m] = np.clip((rgb[m] - (1 - a[m, None])) / a[m, None], 0, 1)
    return out

HAIR = (HUE > 38) & (HUE < 57) & (CH > 38) & (L > 50)   # 头发的橙色：留在底图里，不补洞、眨眼时不跟着压扁

# ── 眼睛 ──
EYE_ROI = {"l": (116, 274, 192, 338), "r": (214, 242, 300, 312)}  # x0, y0, x1, y1（第 1 格坐标；头是歪的，她的左眼低）

def roi_mask(box):
    m = np.zeros((H, W), bool)
    x0, y0, x1, y1 = box
    m[y0:y1, x0:x1] = True
    return m

eyes = {}
for side, box in EYE_ROI.items():
    roi = roi_mask(box)
    amber = roi & (CH > 22) & (HUE > 57) & (HUE < 92) & (L > 18) & (L < 85)   # 琥珀色偏黄，头发橙色相约 50°
    lbl, n = ndimage.label(amber)
    sizes = ndimage.sum(amber, lbl, range(1, n + 1))
    core = lbl == (1 + int(np.argmax(sizes)))
    # 眼珠：琥珀色那块的椭圆（含被上眼睑盖住的部分和里面的高光、瞳孔）
    ys, xs = np.where(core)
    rx = (xs.max() - xs.min()) / 2 + 1.5
    ry = rx * 1.12
    cx = (xs.max() + xs.min()) / 2
    cy = ys.max() + 1 - ry
    yy, xx = np.mgrid[0:H, 0:W]
    iris_ell = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1
    dark = roi & ((L < 30) | ((L < 40) & (HUE < 57)))
    sclera = roi & (L > 70) & (A < 4.5) & (B < 7)
    lbl_s, _ = ndimage.label(sclera)
    touch = set(np.unique(lbl_s[ndimage.binary_dilation(iris_ell, iterations=3) & sclera])) - {0}
    sclera = np.isin(lbl_s, list(touch))
    # 睫毛和眼线：只要和眼眶连着的深色（头发的描线也深，但不和眼眶相连）
    lbl_d, _ = ndimage.label(dark & ~(iris_ell & (yy >= cy - ry * 0.45)), structure=np.ones((3, 3)))
    near_eye = ndimage.binary_dilation(sclera | iris_ell, iterations=2)
    lash = np.isin(lbl_d, list(set(np.unique(lbl_d[near_eye])) - {0}))
    skin = (L > 84) & (A > 3) & (B > 3)
    iris_vis = iris_ell & ~skin & ~HAIR                   # 眼珠真正露出来的地方（椭圆里去掉皮肤和头发色）
    opening = ndimage.binary_dilation(sclera | iris_vis, iterations=1)   # 眼眶：眼白加露出来的眼珠，转动时眼珠裁在这里面
    eyes[side] = dict(box=box, core=core, iris=iris_vis & ~lash, iris_ell=iris_vis, lash=lash, sclera=sclera, opening=opening, cx=cx, cy=cy, rx=rx, ry=ry)

# ── 嘴、手 ──
MOUTH_ROI = (200, 328, 232, 348)
mouth = roi_mask(MOUTH_ROI) & (L < 80) & (A > 6)
HANDS_ROI = (112, 418, 330, H)
paw_skin = roi_mask(HANDS_ROI) & (L > 82) & (A > 4.0) & (B < 12)
lbl_p, n = ndimage.label(paw_skin)
sizes = ndimage.sum(paw_skin, lbl_p, range(1, n + 1))
paws = np.isin(lbl_p, [1 + i for i in np.argsort(sizes)[-2:]])
paws = ndimage.binary_fill_holes(ndimage.binary_closing(paws, iterations=2))
paws_full = ndimage.binary_dilation(paws, iterations=3) & roi_mask(HANDS_ROI)   # 连同外面一圈描线

if DEBUG:
    os.makedirs(DEBUG, exist_ok=True)
    over = (p1 * 255).astype(np.uint8).copy()
    def paint(m, c):
        over[m] = (0.45 * over[m] + 0.55 * np.array(c)).astype(np.uint8)
    for e in eyes.values():
        paint(e["sclera"], (0, 200, 255)); paint(e["iris"], (255, 0, 200)); paint(e["lash"], (0, 255, 0))
    paint(mouth, (255, 255, 0)); paint(paws_full, (0, 0, 255)); paint(near, (255, 0, 0))
    Image.fromarray(over).resize((W * 2, H * 2), Image.NEAREST).save(os.path.join(DEBUG, "masks.png"))
    print("aligned offsets: p2", off2, "p4", off4)
    for s, e in eyes.items():
        print(s, "iris center", round(e["cx"], 1), round(e["cy"], 1), "pixels: iris", int(e["iris"].sum()), "lash", int(e["lash"].sum()), "sclera", int(e["sclera"].sum()))


# ── 图层 ──
def soft(m, r=0.7):
    return np.clip(ndimage.gaussian_filter(m.astype(float), r) * 1.15, 0, 1) * (ndimage.binary_dilation(m, iterations=1))

def inpaint(rgb, mask):
    out = rgb.copy()
    lbl, n = ndimage.label(ndimage.binary_dilation(mask, iterations=1))
    for sl in ndimage.find_objects(lbl):
        y0, y1 = max(0, sl[0].start - 6), min(rgb.shape[0], sl[0].stop + 6)
        x0, x1 = max(0, sl[1].start - 6), min(rgb.shape[1], sl[1].stop + 6)
        sub = restoration.inpaint_biharmonic(rgb[y0:y1, x0:x1], mask[y0:y1, x0:x1], channel_axis=-1)
        out[y0:y1, x0:x1][mask[y0:y1, x0:x1]] = sub[mask[y0:y1, x0:x1]]
    return np.clip(out, 0, 1)

def webp(rgba, q=90):
    im = Image.fromarray(np.clip(np.round(rgba * 255), 0, 255).astype(np.uint8), "RGBA")
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=q, method=6, exact=False)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()

def place(x0, y0, w, h, href, extra=""):
    return f'<image href="{href}" x="{OX + x0 * S:.1f}" y="{OY + y0 * S:.1f}" width="{w * S:.1f}" height="{h * S:.1f}" preserveAspectRatio="none"{extra}/>'

def layer(rgb, a, box, q=90):
    x0, y0, x1, y1 = box
    rgba = np.dstack([rgb[y0:y1, x0:x1], a[y0:y1, x0:x1]])
    return place(x0, y0, x1 - x0, y1 - y0, webp(rgba, q))

def path_of(mask):
    cs = measure.find_contours(np.pad(mask, 1).astype(float), 0.5)
    cs = sorted(cs, key=len, reverse=True)
    d = ""
    for c in cs[:3]:
        if len(c) < 12:
            continue
        c = measure.approximate_polygon(c, 0.5) - 1
        d += "M" + "L".join(f"{OX + x * S:.1f} {OY + y * S:.1f}" for y, x in c) + "Z"
    return d

# 底图：眼睛、嘴、手的地方补洞
remove = np.zeros((H, W), bool)
for e in eyes.values():
    remove |= ndimage.binary_dilation(e["opening"] | e["lash"], iterations=2) & ~HAIR
remove |= ndimage.binary_dilation(mouth, iterations=2) | ndimage.binary_dilation(paws_full, iterations=1)   # 嘴的图层盖 3 圈、手盖 1 圈，正好盖住
remove &= ~bg
hands_hole = ndimage.binary_dilation(paws_full, iterations=1) & ~bg
base_rgb = inpaint(p1, remove & ~hands_hole)
# 手底下：挨着头发的填头发色，其余填衬衫的米色；深色描线不往下带，免得抹成一团或拉出竖条纹
_, (iy, ix) = ndimage.distance_transform_edt(hands_hole, return_indices=True)
near_rgb = p1[iy, ix]
near_is_hair = HAIR[iy, ix]
cream_zone = roi_mask((HANDS_ROI[0], HANDS_ROI[1] - 30, HANDS_ROI[2], HANDS_ROI[1])) & (L > 85) & (B > 10) & (A < 8)
CREAM = np.median(p1[cream_zone], axis=0)
filled = np.where(near_is_hair[..., None], near_rgb, CREAM)
filled = ndimage.gaussian_filter(filled, sigma=(1.5, 1.5, 0))
base_rgb[hands_hole] = filled[hands_hole]
# 往边沿下面补 EXT 行（复制最后一行），侧头、举手时不露切口
base_rgb = np.concatenate([base_rgb, np.repeat(base_rgb[-1:], EXT, axis=0)])
base_a = np.concatenate([alpha, np.repeat(alpha[-1:], EXT, axis=0) * np.linspace(1, 0, EXT)[:, None] ** 0.6])
base_rgb = unmix(base_rgb, base_a)
bust = place(0, 0, W, H + EXT, webp(np.dstack([base_rgb, base_a]), 88))

# 眼睛三层
eye_svg, clips = {}, []
SCLERA = np.median(np.concatenate([p1[e["sclera"]] for e in eyes.values()]), axis=0)
for side, e in eyes.items():
    x0, y0, x1, y1 = e["box"]
    box = (x0 - 4, y0 - 4, x1 + 4, y1 + 4)                         # 比补洞的范围多留 4 像素，边上不露缝
    band = e["iris_ell"] & e["lash"]
    band_zone = ndimage.binary_dilation(band, iterations=1) & e["iris_ell"]
    iris_rgb = inpaint(p1, band_zone)                          # 眼珠里压着上眼线的那截补成眼珠的颜色
    # 三层都用原图像素、硬边：静止时叠起来和原图逐像素一样，没有软边就没有接缝
    a_iris = e["iris_ell"].astype(float)                         # 只取露出来的眼珠像素，硬边
    base_e = p1.copy()
    base_e[ndimage.binary_erosion(e["iris_ell"])] = SCLERA      # 眼珠底下是眼白（往里收 1 像素：静止时眼珠边缘的插值落在原图上，不出亮线）
    a_base = (ndimage.binary_dilation(e["opening"] | e["lash"], iterations=3) & ~HAIR).astype(float)   # 盖住底图补过洞的那一圈（头发除外）
    a_lash = band_zone.astype(float)                             # 只压眼珠范围里那截上眼线
    lash_rgb = p1
    cid = "{id}-open-" + side
    clips.append(f'<clipPath id="{cid}"><path d="{path_of(e["opening"])}"/></clipPath>')
    eye_svg[side] = (f'<g data-part="eye-{side}">{layer(base_e, a_base, box)}'
                     f'<g clip-path="url(#{cid})"><g data-part="iris-{side}">{layer(iris_rgb, a_iris, box)}</g></g>'
                     f'{layer(lash_rgb, a_lash, box)}</g>')

# 嘴：平时（第 1 格）、张嘴（第 2 格）；闭眼（第 4 格）
SKIN = np.array([1.0, 0.925, 0.905])
def ink_alpha(rgb, zone, strength=0.5):
    d = np.sqrt(((rgb - SKIN) ** 2).sum(axis=2))
    return np.where(zone, np.clip(d / strength, 0, 1), 0)
mz = ndimage.binary_dilation(mouth, iterations=3)
mouth_svg = f'<g data-part="mouth">{layer(p1, mz.astype(float), MOUTH_ROI)}</g>'
OPEN_ROI = (196, 322, 236, 356)
lab2 = color.rgb2lab(p2)
open_m = roi_mask(OPEN_ROI) & (np.sqrt(((lab2 - color.rgb2lab(SKIN[None, None]))[..., :3] ** 2).sum(axis=2)) > 9)
open_m = ndimage.binary_opening(open_m, iterations=1)
open_svg = f'<g data-part="mouth-open" display="none">{layer(p2, ink_alpha(p2, ndimage.binary_dilation(open_m, iterations=1), 0.35), OPEN_ROI)}</g>'
closed_svg = ""
lab4 = color.rgb2lab(p4)
for side, e in eyes.items():
    zone = roi_mask(e["box"]) & ((lab4[..., 0] < 55) & (((np.degrees(np.arctan2(lab4[..., 2], lab4[..., 1])) + 360) % 360) < 60))
    zone = ndimage.binary_dilation(zone, iterations=1) & roi_mask(e["box"])
    closed_svg += f'<g data-part="eye-{side}-closed" display="none">{layer(p4, ink_alpha(p4, zone, 0.5), e["box"])}</g>'

# 手：两只扒在胶囊沿上的手，往下补 16 行（举手回弹时不露平切口）
HB = (HANDS_ROI[0], HANDS_ROI[1], HANDS_ROI[2], H)
pad = 16
hrgb = np.concatenate([p1, np.repeat(p1[-1:], pad, axis=0)])
ha = ndimage.binary_dilation(paws_full, iterations=1).astype(float)
ha = np.concatenate([ha, np.repeat(ha[-1:], pad, axis=0) * np.linspace(1, 0, pad)[:, None]])
hands = f'<g data-part="arm-peace" data-pivot="447 860">{layer(hrgb, ha, (HB[0], HB[1], HB[2], H + pad))}</g>'

# 右耳戴一只 AirPods（原图没有；产品里在听时它会亮）。耳垂在第 1 格约 (334, 292)
ax, ay = OX + 333 * S, OY + 287 * S
airpod = (f'<g data-part="airpod-r"><rect x="{ax - 4:.1f}" y="{ay + 4:.1f}" width="8.5" height="26" rx="4.2" fill="#fff" stroke="#a7aebd" stroke-width="1.6"/>'
          f'<ellipse cx="{ax:.1f}" cy="{ay:.1f}" rx="8.5" ry="7.5" fill="#fff" stroke="#a7aebd" stroke-width="1.6"/>'
          f'<ellipse cx="{ax - 2.5:.1f}" cy="{ay - 1.5:.1f}" rx="2.6" ry="2" fill="#a1a9b8"/></g>')

clips.append('<clipPath id="{id}-lip"><rect x="0" y="100" width="900" height="776"/></clipPath>')   # 和胶囊上沿一样高
inner = (f'<defs>{"".join(clips)}</defs><g data-part="miles" clip-path="url(#{{id}}-lip)"><g data-part="body" data-pivot="388 1182"><g data-part="head" data-pivot="444 806">'
         f'{bust}{eye_svg["l"]}{eye_svg["r"]}{closed_svg}{mouth_svg}{open_svg}{airpod}</g></g>{hands}</g>')
ART = {"viewBox": "20 140 860 1080", "torsoCx": 447, "lipY": 900, "figureWidth": 773, "topY": 167, "gazeUnit": 7}
art_ts = "{ " + ", ".join(f'{k}: {json.dumps(v)}' for k, v in ART.items()) + " }"
doc = """/**
 * C妹 的伙伴形象（2026-11-03 设计稿，待定稿）：一比一取自孙铭泽提供并确认有授权的原图 source/c-mei-sheet.webp。
 * 平时取第 1 格，说话的嘴取第 2 格，闭眼取第 4 格；两只手扒在胶囊沿上。只多画了一只右耳的 AirPods，产品里「在听」时它会亮。
 * 和 milesRig 的约定：同一坐标系和摆位，同一套 data-part；body 里套着 head，所以侧头和呼吸带着整个上半身。
 * 眼珠（data-part="iris-l/r"）裁在眼眶里：milesRig 打上 .scratch/buddy-girl-avatar/milesRig-iris-gaze.patch 后，转眼时只移眼珠。
 * gazeUnit 是 7（Miles 是 15）：她的眼珠小，转眼幅度跟着收小。手的转轴在两只手中间（447 860）。
 * 裁切的 id 写成 `{id}-…`，挂的时候换成每一颗自己的前缀。
 *
 * 由 .scratch/buddy-cmei/build.py 生成，别手改。
 */""".replace("`", "\\`")
out_dir = HERE
open(os.path.join(out_dir, "cmeiArt.ts"), "w").write(f"{doc}\n\n/** 摆位用的几个量：除了 gazeUnit，和 MILES_ART 相同。 */\nexport const CMEI_ART = {art_ts} as const;\n\nexport const CMEI_SVG = `{inner}`;\n")
open(os.path.join(out_dir, "cmei.svg"), "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{ART["viewBox"]}" width="860" height="1080">{inner.replace("{id}", "cmei")}</svg>\n')
print("cmeiArt.ts", os.path.getsize(os.path.join(out_dir, "cmeiArt.ts")), "bytes")
