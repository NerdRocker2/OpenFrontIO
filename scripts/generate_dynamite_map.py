"""
generate_dynamite_map.py
Generates the Dynamite TNT map image for OpenFront.io.

Output: map-generator/assets/maps/dynamite/image.png  (3840 x 2160)
        map-generator/assets/maps/dynamite/info.json   (nation spawn list)

OpenFront blue-channel encoding:
  blue = 106  → Water (ocean)
  blue < 140  → Land plains mag 0  (clamped)
  blue 140    → Land plains mag 0  (lightest green)
  blue 150    → Land plains mag 5  (medium green)
  blue 158    → Land plains mag 9  (darkest green — borders)
  blue 159    → Land highland mag 0 (≈ brightest brown)
  blue 178    → Land highland mag 19 (lightest brown/cream)
  blue 179    → Land mountain mag 0  (darkest white)
  blue 200    → Land mountain mag 30 (brightest white)

Usage:
  C:\\Users\\Jeff\\AppData\\Local\\Programs\\Python\\Python313\\python.exe scripts/generate_dynamite_map.py
"""

import os
import json
import math
from PIL import Image, ImageDraw

# ── Output paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT   = os.path.dirname(SCRIPT_DIR)
OUT_DIR     = os.path.join(REPO_ROOT, "map-generator", "assets", "maps", "dynamite")
IMG_PATH    = os.path.join(OUT_DIR, "image.png")
INFO_PATH   = os.path.join(OUT_DIR, "info.json")

os.makedirs(OUT_DIR, exist_ok=True)

# ── Canvas ────────────────────────────────────────────────────────────────────
W, H = 3840, 2160

# ── Blue-channel constants (R=0, G=0 always; only B matters) ─────────────────
B_WATER        = 106   # water / TNT-letter transparent
B_BORDER       = 158   # darkest green border/divider
B_GREEN_LIGHT  = 140   # lightest green band
B_GREEN_MED    = 150   # medium green band
B_BROWN_DARK   = 159   # brightest (darker) brown — top squares
B_BROWN_LIGHT  = 178   # lightest (lighter) brown/cream — top squares
B_WHITE_DARK   = 179   # darkest white — label bottom
B_WHITE_BRIGHT = 200   # brightest white — label top


def px(b):
    """Return an RGBA pixel tuple for a given blue channel value (R=G=0, A=255)."""
    return (0, 0, b, 255)


# ── Large box dimensions ──────────────────────────────────────────────────────
# Square front face. Depth sized to match Dynamite.png screen ratios:
#   Right face horizontal screen extent / front width  ≈ 0.27
#   Top  face vertical   screen extent  / front height ≈ 0.16
#   → proj_dx = 27% × 760 = 205px,  proj_dy = 16% × 760 = 122px
LF_W  = 760    # large front width
LF_H  = 760    # large front height (square face, like reference)
LD    = 314    # depth  → proj_dx ≈ 205px (27% of LF_W), proj_dy ≈ 120px (16% of LF_H)

# ── Small box dimensions ──────────────────────────────────────────────────────
SF_W  = 195    # small front width
SF_H  = 195    # small front height (square)
SD    = 81     # depth  → proj_dx ≈ 53px (27% of SF_W), proj_dy ≈ 31px (16% of SF_H)

# ── Oblique projection angles ─────────────────────────────────────────────────
# Derived from precise ratio measurement of Dynamite.png reference image:
#
#   Screen ratios measured on the large box:
#     right-face horizontal extent / front width  = ~0.27
#     top-face  vertical   extent  / front height = ~0.16
#     dy/dx screen ratio = 0.16/0.27 = 0.59  → screen angle = arctan(0.59) ≈ 30.5°
#
#   These screen ratios come from:
#     plan angle      = 45 degrees  (depth goes back-right in 3D space)
#     elevation angle = 22.5 degrees (how far depth lifts upward)
#     screen_dx = cos(22.5) × cos(45) ≈ 0.653  per unit of depth
#     screen_dy = sin(22.5)           ≈ 0.383  per unit of depth
#
#   Verification with LD=314:
#     proj_dx = 314 × 0.653 = 205px  (205/760 = 27% ✓)
#     proj_dy = 314 × 0.383 = 120px  (120/760 = 16% ✓)
#
# Earlier attempts used too-large depth values (603, 327) which made the side/top
# faces dominate and the box appear to have a corner facing the viewer.
DEPTH_PLAN_DEG = 45.0
DEPTH_ELEV_DEG = 22.5
_COS_DX = math.cos(math.radians(DEPTH_ELEV_DEG)) * math.cos(math.radians(DEPTH_PLAN_DEG))
_SIN_DY = math.sin(math.radians(DEPTH_ELEV_DEG))


def proj_dx(depth: float) -> int:
    """Screen-space rightward offset for a given depth value."""
    return int(depth * _COS_DX)


def proj_dy(depth: float) -> int:
    """Screen-space upward offset for a given depth value."""
    return int(depth * _SIN_DY)

# ── Box band proportions (fraction of front height) ──────────────────────────
# Front face layout (top → bottom):
#   border_top (thin)
#   green_band_top (above label, split into 3 equal stripes)
#   border_mid_top
#   label_band
#   border_mid_bot
#   green_band_bot (below label, split into 3 equal stripes)
#   border_bot (thin)
BORDER_PX   = 5    # thin border thickness (pixels, absolute for large box)
# band fractions of (front_height - 2*border_top - 2*border_mid - 1*border_bot)
GREEN_FRAC  = 0.28   # each green area (above + below label)
LABEL_FRAC  = 0.30   # TNT label band


# ── Pixelated TNT letters (5×7 bitmap each, T N T) ───────────────────────────
# 1 = letter pixel (water, B=106), 0 = background (white gradient)
_T = [
    [1,1,1,1,1],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
]
_N = [
    [1,0,0,0,1],
    [1,1,0,0,1],
    [1,0,1,0,1],
    [1,0,0,1,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
]
TNT_BITMAPS = [_T, _N, _T]
LETTER_COLS = 5
LETTER_ROWS = 7


def draw_tnt_letters(pixel_access, img_pixels, x0, y0, band_w, band_h):
    """
    Draw pixelated "TNT" letters as water (B_WATER) on the label band.
    pixel_access = PixelAccess object from img.load()
    x0, y0 = top-left of the label band on the canvas.
    band_w, band_h = pixel dimensions of the label band.
    """
    gap_between = LETTER_COLS // 2 + 1   # gap cols between letters
    total_cols  = LETTER_COLS * 3 + gap_between * 2
    # Scale so letters take ~65% of band width, centered
    scale = max(1, int((band_w * 0.65) / total_cols))
    # Ensure scale doesn't make letters taller than band
    scale = min(scale, max(1, int(band_h * 0.80 / LETTER_ROWS)))

    letter_w   = LETTER_COLS * scale
    gap_w      = gap_between * scale
    total_px_w = letter_w * 3 + gap_w * 2
    total_px_h = LETTER_ROWS * scale

    start_x = x0 + (band_w  - total_px_w) // 2
    start_y = y0 + (band_h  - total_px_h) // 2

    for li, bitmap in enumerate(TNT_BITMAPS):
        lx = start_x + li * (letter_w + gap_w)
        for row in range(LETTER_ROWS):
            for col in range(LETTER_COLS):
                if bitmap[row][col]:
                    for dy in range(scale):
                        for dx in range(scale):
                            cx = lx + col * scale + dx
                            cy = start_y + row * scale + dy
                            if 0 <= cx < W and 0 <= cy < H:
                                pixel_access[cx, cy] = px(B_WATER)


def draw_tnt_box(img_pixels, cx, cy, fw, fh, depth, border=BORDER_PX):
    """
    Draw one isometric-oblique TNT box.
    cx, cy   = center of the FRONT FACE
    fw, fh   = front face width and height
    depth    = oblique projection depth (pixels right + up for side + top)

    Faces drawn back→front:
      1. Top face  (parallelogram, above front face top-left corner)
      2. Right side face (parallelogram, right of front face)
      3. Front face (rectangle)
    Then borders are overdrawn.
    """
    draw = ImageDraw.Draw(img_pixels)

    # Front face corners (top-left origin)
    fl = cx - fw // 2
    ft = cy - fh // 2
    fr = fl + fw
    fb = ft + fh

    # Depth vector: plan 45 degrees, elevation 22.5 degrees (Dynamite.png reference)
    dx = proj_dx(depth)
    dy = proj_dy(depth)  # upward offset

    # ── 1. Right side face ────────────────────────────────────────────────────
    # Vertices: front top-right, front bot-right, side bot-right, side top-right
    side_tl = (fr,       ft)
    side_bl = (fr,       fb)
    side_br = (fr + dx,  fb - dy)
    side_tr = (fr + dx,  ft - dy)
    draw.polygon([side_tl, side_bl, side_br, side_tr],
                 fill=px(B_GREEN_LIGHT))
    # Draw horizontal band pattern on side face (match front face bands, foreshortened)
    _draw_side_bands(img_pixels, draw, side_tl, side_bl, side_br, side_tr, fw, fh, depth, border)

    # ── 2. Top face ───────────────────────────────────────────────────────────
    # Vertices: front top-left, front top-right, side top-right, side top-left
    top_bl = (fl,       ft)
    top_br = (fr,       ft)
    top_tr = (fr + dx,  ft - dy)
    top_tl = (fl + dx,  ft - dy)
    _draw_top_checkerboard(img_pixels, draw, top_bl, top_br, top_tr, top_tl, fw, depth)

    # ── 3. Front face ─────────────────────────────────────────────────────────
    _draw_front_face(img_pixels, draw, fl, ft, fw, fh, border)

    # ── 4. Box outline borders ────────────────────────────────────────────────
    b = max(3, border)
    # Front face outline
    draw.rectangle([fl, ft, fr, fb], outline=px(B_BORDER), width=b)
    # Right side outline
    draw.polygon([side_tl, side_bl, side_br, side_tr],
                 outline=px(B_BORDER))
    for t in range(b):
        draw.line([
            (side_tl[0]+t, side_tl[1]), (side_tr[0]+t, side_tr[1]),
            (side_br[0]+t, side_br[1]), (side_bl[0]+t, side_bl[1]),
        ], fill=px(B_BORDER), width=1)
    # Top face outline
    draw.polygon([top_bl, top_br, top_tr, top_tl], outline=px(B_BORDER))
    # Connecting edge lines (depth lines)
    draw.line([(fl, ft), (fl+dx, ft-dy)], fill=px(B_BORDER), width=b)
    draw.line([(fr, ft), (fr+dx, ft-dy)], fill=px(B_BORDER), width=b)
    draw.line([(fr, fb), (fr+dx, fb-dy)], fill=px(B_BORDER), width=b)


def _draw_front_face(img_pixels, draw, fl, ft, fw, fh, border):
    """
    Fill the front face rectangle with band pattern.
    Layout (top→bottom):
      border_top
      green_band_top  (3 equal horizontal stripes of alternating green)
      border_mid_top
      label_band      (white gradient + TNT letters)
      border_mid_bot
      green_band_bot  (3 equal horizontal stripes of alternating green)
      border_bot
    """
    b = max(1, border)
    usable_h = fh - 4 * b   # 2 outer + 2 inner borders
    green_h  = int(usable_h * GREEN_FRAC)
    label_h  = usable_h - 2 * green_h

    y = ft
    # top border
    draw.rectangle([fl, y, fl+fw-1, y+b-1], fill=px(B_BORDER))
    y += b
    # green band top
    _draw_green_band(img_pixels, draw, fl, y, fw, green_h, vertical_stripes=True)
    y += green_h
    # mid border top
    draw.rectangle([fl, y, fl+fw-1, y+b-1], fill=px(B_BORDER))
    y += b
    # label band
    _draw_label_band(img_pixels, draw, fl, y, fw, label_h, border)
    label_y0 = y
    y += label_h
    # mid border bot
    draw.rectangle([fl, y, fl+fw-1, y+b-1], fill=px(B_BORDER))
    y += b
    # green band bot
    _draw_green_band(img_pixels, draw, fl, y, fw, green_h, vertical_stripes=True)
    y += green_h
    # bottom border
    draw.rectangle([fl, y, fl+fw-1, y+b-1], fill=px(B_BORDER))


def _draw_green_band(img_pixels, draw, x0, y0, band_w, band_h, vertical_stripes=True):
    """
    Alternating light/medium green columns (vertical stripes).
    """
    stripe_w = max(1, band_w // 8)
    for col in range(0, band_w, stripe_w):
        b_val = B_GREEN_LIGHT if (col // stripe_w) % 2 == 0 else B_GREEN_MED
        x1 = x0 + col
        x2 = min(x0 + col + stripe_w - 1, x0 + band_w - 1)
        draw.rectangle([x1, y0, x2, y0 + band_h - 1], fill=px(b_val))


def _draw_label_band(img_pixels, draw, x0, y0, band_w, band_h, border):
    """
    White gradient label band (brightest white top → darkest white bottom, 75/25 split).
    TNT letters drawn as water.
    """
    for row in range(band_h):
        frac = row / max(1, band_h - 1)
        # 75% of height is pure bright white; last 25% fades to dark white
        if frac <= 0.75:
            b_val = B_WHITE_BRIGHT
        else:
            t = (frac - 0.75) / 0.25   # 0→1 over last 25%
            b_val = int(B_WHITE_BRIGHT - t * (B_WHITE_BRIGHT - B_WHITE_DARK))
        draw.rectangle([x0, y0 + row, x0 + band_w - 1, y0 + row],
                       fill=px(b_val))

    # Draw TNT letters using direct pixel access
    pixel_access = img_pixels.load()
    draw_tnt_letters(pixel_access, img_pixels, x0, y0, band_w, band_h)


def _draw_top_checkerboard(img_pixels, draw, top_bl, top_br, top_tr, top_tl, fw, depth):
    """
    Draw a 4×4 checkerboard on the top face, alternating B_BROWN_DARK / B_BROWN_LIGHT.
    Uses a simple scan-line fill within the parallelogram.
    """
    # The top face is a parallelogram. We fill it by iterating over the
    # parallelogram grid. The base vector goes from top_bl → top_br (length fw).
    # The depth vector goes from top_bl → top_tl (oblique).
    # Grid: 4 columns × 4 rows
    cols = 4
    rows = 4

    bx = top_bl[0]
    by = top_bl[1]
    # base vector (right along top face front edge)
    rx = (top_br[0] - top_bl[0]) / cols
    ry = (top_br[1] - top_bl[1]) / cols
    # depth vector (back along top face)
    px_ = (top_tl[0] - top_bl[0]) / rows
    py_ = (top_tl[1] - top_bl[1]) / rows

    for row in range(rows):
        for col in range(cols):
            c = B_BROWN_DARK if (row + col) % 2 == 0 else B_BROWN_LIGHT
            # Four corners of this cell
            pts = []
            for dr, dc in [(0,0),(0,1),(1,1),(1,0)]:
                ox = bx + (col+dc)*rx + (row+dr)*px_
                oy = by + (col+dc)*ry + (row+dr)*py_
                pts.append((ox, oy))
            draw.polygon(pts, fill=px(c))

    # Thin grid lines on top face
    for i in range(cols + 1):
        ox = bx + i*rx
        oy = by + i*ry
        draw.line([(ox, oy), (ox + rows*px_, oy + rows*py_)],
                  fill=px(B_BORDER), width=2)
    for j in range(rows + 1):
        ox = bx + j*px_
        oy = by + j*py_
        draw.line([(ox, oy), (ox + cols*rx, oy + cols*ry)],
                  fill=px(B_BORDER), width=2)


def _draw_side_bands(img_pixels, draw, side_tl, side_bl, side_br, side_tr,
                     fw, fh, depth, border):
    """
    Fill the right side face with horizontal bands matching the front face layout,
    slightly darker (use medium green instead of light for side).
    """
    b = max(1, border)
    usable_h = fh - 4 * b
    green_h  = int(usable_h * GREEN_FRAC)
    label_h  = usable_h - 2 * green_h

    # The side face spans the same height as front face but is foreshortened.
    # We draw horizontal bands from top to bottom using the parallelogram shape.
    # Simplification: fill entire side as medium green with a label-colored stripe.
    # Use same y-proportions as front but mapped to parallelogram.

    # Interpolation helper: for a given y in [side_tl[1], side_bl[1]], return
    # the left and right x boundaries of the parallelogram.
    h_side = side_bl[1] - side_tl[1]
    if h_side <= 0:
        return

    def lerp(a, b_, t):
        return a + (b_ - a) * t

    def get_band_strip(y0, y1, fill_b):
        # Clip y values
        ty0 = max(0, y0)
        ty1 = min(H, y1)
        for row in range(ty0, ty1):
            t = (row - side_tl[1]) / h_side
            t = max(0.0, min(1.0, t))
            lx = lerp(side_tl[0], side_bl[0], t)
            rx = lerp(side_tr[0], side_br[0], t)
            if rx > lx:
                draw.rectangle([int(lx), row, int(rx), row], fill=px(fill_b))

    y = side_tl[1]
    get_band_strip(y, y + b, B_BORDER);  y += b
    get_band_strip(y, y + green_h, B_GREEN_MED);  y += green_h
    get_band_strip(y, y + b, B_BORDER);  y += b
    get_band_strip(y, y + label_h, B_WHITE_DARK);  y += label_h
    get_band_strip(y, y + b, B_BORDER);  y += b
    get_band_strip(y, y + green_h, B_GREEN_MED);  y += green_h
    get_band_strip(y, y + b, B_BORDER)


# ── Layout calculation ────────────────────────────────────────────────────────

def box_rect(cx, cy, fw, fh, depth):
    """Return (left, top, right, bottom) bounding rect of a box (all 3 faces)."""
    dx = proj_dx(depth)
    dy = proj_dy(depth)
    fl = cx - fw // 2
    ft = cy - fh // 2
    fr = fl + fw
    fb = ft + fh
    # include right side and top face
    left   = fl
    top    = ft - dy
    right  = fr + dx
    bottom = fb
    return (left, top, right, bottom)


def rects_overlap(r1, r2, margin=0):
    """Return True if two (l,t,r,b) rects overlap (with optional margin)."""
    l1,t1,r1_,b1 = r1
    l2,t2,r2_,b2 = r2
    return not (r1_ + margin < l2 or r2_ + margin < l1 or
                b1 + margin < t2 or b2 + margin < t1)


# ── Small box grid ────────────────────────────────────────────────────────────
# We want ~8 boxes per row (even rows), 7 boxes per odd row (brick offset).
# The box total visual width = SF_W + dx, height = SF_H + dy (bounding rect).

dx_s = proj_dx(SD)
dy_s = proj_dy(SD)
BOX_VISUAL_W = SF_W + dx_s + 20   # spacing between box centers in even rows
BOX_VISUAL_H = SF_H + dy_s + 20   # spacing between box centers vertically

# Compute starting x so 8 boxes fit centered within width
N_COLS_EVEN = 8
N_COLS_ODD  = 7
N_ROWS      = 5

# Center 8-wide grid
grid_total_w = N_COLS_EVEN * BOX_VISUAL_W
start_x = (W - grid_total_w) // 2 + BOX_VISUAL_W // 2

# Center rows vertically
grid_total_h = N_ROWS * BOX_VISUAL_H
start_y = (H - grid_total_h) // 2 + BOX_VISUAL_H // 2

# Large box: centered horizontally RIGHT half (x center = 3/4 of W), vertically centered
LARGE_CX = W * 3 // 4
LARGE_CY = H // 2

EXCLUSION_MARGIN = 100

large_rect = box_rect(LARGE_CX, LARGE_CY, LF_W, LF_H, LD)
# Inflate with margin
large_rect_margin = (
    large_rect[0] - EXCLUSION_MARGIN,
    large_rect[1] - EXCLUSION_MARGIN,
    large_rect[2] + EXCLUSION_MARGIN,
    large_rect[3] + EXCLUSION_MARGIN,
)


def compute_small_boxes():
    """Return list of (cx, cy) for all valid small box positions."""
    boxes = []
    for row in range(N_ROWS):
        n_cols = N_COLS_EVEN if row % 2 == 0 else N_COLS_ODD
        row_offset = 0 if row % 2 == 0 else BOX_VISUAL_W // 2
        cy = start_y + row * BOX_VISUAL_H
        for col in range(n_cols):
            cx = start_x + col * BOX_VISUAL_W + row_offset
            # Check fully within canvas (include 3D projection)
            r = box_rect(cx, cy, SF_W, SF_H, SD)
            if r[0] < 0 or r[1] < 0 or r[2] > W or r[3] > H:
                continue  # skip out-of-bounds
            # Check overlap with large box (+ margin)
            if rects_overlap(r, large_rect_margin, margin=0):
                continue  # skip overlapping boxes
            boxes.append((cx, cy))
    return boxes


# ── Nation names ──────────────────────────────────────────────────────────────
SMALL_NATION_NAMES = [
    "Kaboom",
    "Crater Lake",
    "Gunpowder Falls",
    "TNT Terrace",
    "Ignition Point",
    "Fuse City",
    "Blastville",
    "Nitro Heights",
    "Detonator Bay",
    "Flashpoint",
    "Pyrex Peak",
    "ACME Hills",
    "Coyote Flats",
    "Roadrunner Ridge",
    "Powder Keg",
    "Boom Town",
    "Crater Canyon",
    "Spark Gap",
    "Concussion Cove",
    "Shockwave Shore",
    "Blastoff Bay",
    "Sulfur Springs",
    "Smoke Signal",
    "Burn Barrel",
    "Detonation Dunes",
    "Blaze Ridge",
    "Firework Falls",
    "Combustion Creek",
    "Powder Barrel",
    "Big Boom Bay",
    "Blast Radius",
    "Zero Hour",
    "Chain Reaction",
    "The Fuse",
    "Crater Face",
    "Gunpowder Trail",
    "Spark Plug",
    "Kaboom County",
]

LARGE_NATION_NAMES = [
    "Meep Meep Meadows",
    "ACME Headquarters",
    "Wile E. Gulch",
]


# ── Large box nation coordinates ──────────────────────────────────────────────
def large_nation_coords(fw, fh, depth, cx, cy):
    """
    Return [x,y] for three spawn points in the large box:
      1. Top center: center of top face
      2. Center of green band above label (front face)
      3. Center of green band below label (front face)
    All as integer pixel coords [x, y].
    """
    b = max(1, BORDER_PX)
    usable_h = fh - 4 * b
    green_h  = int(usable_h * GREEN_FRAC)
    label_h  = usable_h - 2 * green_h

    fl = cx - fw // 2
    ft = cy - fh // 2

    dx_ = int(depth * math.cos(math.radians(45)))
    dy_ = int(depth * math.sin(math.radians(45)))

    # 1. Top center: midpoint of the top face parallelogram
    top_cx = cx + dx_ // 2
    top_cy = ft - dy_ // 2
    # Clamp inside front face horizontally
    top_cx = cx

    # 2. Center of green band above label
    above_y = ft + b + green_h // 2
    above_x = cx

    # 3. Center of green band below label
    below_y = ft + b + green_h + b + label_h + b + green_h // 2
    below_x = cx

    return [
        [top_cx, top_cy],
        [above_x, above_y],
        [below_x, below_y],
    ]


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print(f"Canvas: {W}x{H}")
    print(f"Large box: front {LF_W}x{LF_H}, depth {LD}, center ({LARGE_CX},{LARGE_CY})")
    print(f"Small box: front {SF_W}x{SF_H}, depth {SD}")
    print(f"Grid: {N_ROWS} rows, {N_COLS_EVEN}/{N_COLS_ODD} cols even/odd")

    # Create image filled with water (B_WATER)
    img = Image.new("RGBA", (W, H), (0, 0, B_WATER, 255))
    img_pixels = img

    # Compute small box positions
    small_boxes = compute_small_boxes()
    print(f"Small boxes to draw: {len(small_boxes)}")

    # Estimate land tile count
    # Large box land area ≈ fw*fh + (fw * depth/2) + (fw * depth/2)  (approx)
    dx_l = int(LD * math.cos(math.radians(45)))
    dy_l = int(LD * math.sin(math.radians(45)))
    # Subtract water (label TNT letters) from front face
    label_h_large = LF_H - 4*BORDER_PX - 2*int((LF_H - 4*BORDER_PX)*GREEN_FRAC)
    # Rough letter area: 3 letters × 5×7 × scale²
    scale_large = max(1, int((LF_W * 0.65) / (5*3+2*2)))
    scale_large = min(scale_large, max(1, int(label_h_large * 0.80 / 7)))
    letter_water_large = 3 * int(0.55 * 5*7) * scale_large * scale_large  # ~55% of letter bitmaps are water
    large_land = LF_W * LF_H + LF_W * dx_l // 2 + LF_W * dy_l // 2 - letter_water_large

    label_h_small = SF_H - 4*BORDER_PX - 2*int((SF_H - 4*BORDER_PX)*GREEN_FRAC)
    scale_small = max(1, int((SF_W * 0.65) / (5*3+2*2)))
    scale_small = min(scale_small, max(1, int(label_h_small * 0.80 / 7)))
    letter_water_small = 3 * int(0.55 * 5*7) * scale_small * scale_small
    small_land_per_box = SF_W * SF_H + SF_W * dx_s // 2 + SF_W * dy_s // 2 - letter_water_small
    total_small_land = len(small_boxes) * small_land_per_box

    estimated_land = large_land + total_small_land
    print(f"Estimated land tiles: {estimated_land:,} (limit: 3,000,000)")
    if estimated_land > 3_000_000:
        print("WARNING: Estimated land tiles exceed 3M limit! Reduce box sizes.")

    # Draw small boxes first (behind large box)
    print("Drawing small boxes...")
    for i, (cx, cy) in enumerate(small_boxes):
        draw_tnt_box(img_pixels, cx, cy, SF_W, SF_H, SD, border=max(2, BORDER_PX // 2))

    # Draw large box on top
    print("Drawing large box...")
    draw_tnt_box(img_pixels, LARGE_CX, LARGE_CY, LF_W, LF_H, LD, border=BORDER_PX)

    # Save
    img.save(IMG_PATH)
    print(f"Saved: {IMG_PATH}")

    # Build info.json
    nations = []

    # Small box nations
    for i, (cx, cy) in enumerate(small_boxes):
        name = SMALL_NATION_NAMES[i % len(SMALL_NATION_NAMES)]
        nations.append({
            "coordinates": [cx, cy],
            "name": name,
            "flag": ""
        })

    # Large box nations
    large_coords = large_nation_coords(LF_W, LF_H, LD, LARGE_CX, LARGE_CY)
    for i, (name, coords) in enumerate(zip(LARGE_NATION_NAMES, large_coords)):
        nations.append({
            "coordinates": coords,
            "name": name,
            "flag": ""
        })

    info = {
        "name": "Dynamite",
        "nations": nations
    }
    with open(INFO_PATH, "w") as f:
        json.dump(info, f, indent=2)
    print(f"Saved: {INFO_PATH}")
    print(f"Total nations: {len(nations)}")

    # Count actual land pixels
    print("Counting actual land pixels...")
    pixels = img.load()
    land_count = 0
    for x in range(W):
        for y in range(H):
            r, g, b, a = pixels[x, y]
            if a >= 20 and b != 106:
                land_count += 1
    print(f"Actual land pixels: {land_count:,}")
    if land_count > 3_000_000:
        print("ERROR: Actual land pixels exceed 3,000,000 limit!")
    else:
        print("OK: Within land tile limit.")


if __name__ == "__main__":
    main()
