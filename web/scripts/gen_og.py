#!/usr/bin/env python3
"""
Genera le immagini social (link preview) del sito di Nicu con Pillow.

Output:
  public/og.png         1200x630  (Facebook / X / link generici)
  public/og-square.png   800x800  (WhatsApp)

Uso:
  python scripts/gen_og.py [--domain nicu.chat]
"""
from __future__ import annotations

import argparse
import io
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(WEB_ROOT, "public")
FONTS_DIR = r"C:\Windows\Fonts"

FONT_BOLD = os.path.join(FONTS_DIR, "segoeuib.ttf")
FONT_ITALIC = os.path.join(FONTS_DIR, "segoeuii.ttf")
FONT_REGULAR = os.path.join(FONTS_DIR, "segoeui.ttf")

AVATAR_PATH = os.path.join(PUBLIC, "nicu-happy.png")

# --- palette brand ------------------------------------------------------
BG_DARK1 = (10, 22, 40)      # #0a1628
BG_DARK2 = (13, 31, 58)      # #0d1f3a
ORANGE1 = (232, 106, 43)     # #e86a2b
ORANGE2 = (240, 144, 64)     # #f09040
WHITE = (245, 245, 245)      # #f5f5f5
MUTED = (122, 155, 181)      # #7a9bb5

SS = 4  # supersample factor per maschere/anelli antialiased


# -------------------------------------------------------------------------
# helpers colore / gradiente
# -------------------------------------------------------------------------
def diagonal_gradient(w: int, h: int, c1: tuple, c2: tuple) -> Image.Image:
    """Gradiente diagonale (alto-sx -> basso-dx), calcolato con numpy."""
    xs = np.linspace(0.0, 1.0, w, dtype=np.float32)
    ys = np.linspace(0.0, 1.0, h, dtype=np.float32)
    xx, yy = np.meshgrid(xs, ys)
    t = (xx + yy) / 2.0
    t = t[..., None]
    c1a = np.array(c1, dtype=np.float32)
    c2a = np.array(c2, dtype=np.float32)
    rgb = c1a * (1 - t) + c2a * t
    rgb = rgb.astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB").convert("RGBA")


def radial_glow(w: int, h: int, center: tuple, radius: float, color: tuple, max_alpha: int) -> Image.Image:
    """Layer RGBA con un glow radiale morbido (falloff quadratico)."""
    xs = np.arange(w, dtype=np.float32)
    ys = np.arange(h, dtype=np.float32)
    xx, yy = np.meshgrid(xs, ys)
    dist = np.sqrt((xx - center[0]) ** 2 + (yy - center[1]) ** 2)
    t = np.clip(1.0 - dist / radius, 0.0, 1.0)
    alpha = (t ** 2) * max_alpha
    layer = np.zeros((h, w, 4), dtype=np.uint8)
    layer[..., 0] = color[0]
    layer[..., 1] = color[1]
    layer[..., 2] = color[2]
    layer[..., 3] = alpha.astype(np.uint8)
    return Image.fromarray(layer, mode="RGBA")


def vertical_gradient_rgba(size_w: int, size_h: int, c1: tuple, c2: tuple) -> Image.Image:
    """Gradiente verticale morbido (usato per riempire l'anello)."""
    base = Image.new("RGB", (1, 2))
    base.putpixel((0, 0), c1)
    base.putpixel((0, 1), c2)
    grad = base.resize((size_w, size_h), Image.LANCZOS).convert("RGBA")
    return grad


# -------------------------------------------------------------------------
# avatar circolare + anello
# -------------------------------------------------------------------------
def circular_mask(size: int, supersample: int = SS) -> Image.Image:
    big = size * supersample
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, big - 1, big - 1), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def make_avatar(path: str, size: int) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    s = min(w, h)
    left, top = (w - s) // 2, (h - s) // 2
    im = im.crop((left, top, left + s, top + s))
    im = im.resize((size * SS, size * SS), Image.LANCZOS)
    im = im.resize((size, size), Image.LANCZOS)
    mask = circular_mask(size)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


def make_ring(outer: int, inner: int, c1: tuple, c2: tuple, supersample: int = SS) -> Image.Image:
    """Anello (ciambella) con bordo antialiasato e riempimento a gradiente."""
    big_o = outer * supersample
    big_i = inner * supersample
    mask = Image.new("L", (big_o, big_o), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.ellipse((0, 0, big_o - 1, big_o - 1), fill=255)
    off = (big_o - big_i) // 2
    mdraw.ellipse((off, off, off + big_i - 1, off + big_i - 1), fill=0)
    mask = mask.resize((outer, outer), Image.LANCZOS)

    grad = vertical_gradient_rgba(outer, outer, c1, c2)
    ring = Image.new("RGBA", (outer, outer), (0, 0, 0, 0))
    ring.paste(grad, (0, 0), mask)
    return ring


# -------------------------------------------------------------------------
# testo
# -------------------------------------------------------------------------
def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def text_size(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1], bbox

def fit_single_line(draw, text, font_path, max_width, start_size, min_size=18):
    size = start_size
    while size > min_size:
        font = load_font(font_path, size)
        w, _, _ = text_size(draw, text, font)
        if w <= max_width:
            return font
        size -= 2
    return load_font(font_path, min_size)


def draw_text_lr(draw, xy, text, font, fill, anchor_left=True):
    """Disegna testo con anchor 'la' (left-ascender) per allineamento pulito."""
    draw.text(xy, text, font=font, fill=fill, anchor="la" if anchor_left else "ma")


# -------------------------------------------------------------------------
# build immagini
# -------------------------------------------------------------------------
def build_og_wide(domain: str) -> Image.Image:
    W, H = 1200, 630
    canvas = diagonal_gradient(W, H, BG_DARK1, BG_DARK2)
    draw = ImageDraw.Draw(canvas)

    avatar_d = 380
    margin_left = 70
    avatar_cx = margin_left + avatar_d // 2
    avatar_cy = H // 2

    # glow radiale arancio dietro l'avatar
    glow = radial_glow(W, H, (avatar_cx, avatar_cy), radius=avatar_d * 1.05, color=ORANGE1, max_alpha=95)
    glow = glow.filter(ImageFilter.GaussianBlur(18))
    canvas.alpha_composite(glow)

    # anello sottile sfumato
    ring_gap = 8
    ring_thick = 7
    ring_outer_d = avatar_d + 2 * ring_gap + 2 * ring_thick
    ring = make_ring(ring_outer_d, avatar_d + 2 * ring_gap, ORANGE1, ORANGE2)
    ring_pos = (avatar_cx - ring_outer_d // 2, avatar_cy - ring_outer_d // 2)
    canvas.alpha_composite(ring, ring_pos)

    # avatar
    avatar = make_avatar(AVATAR_PATH, avatar_d)
    avatar_pos = (avatar_cx - avatar_d // 2, avatar_cy - avatar_d // 2)
    canvas.alpha_composite(avatar, avatar_pos)

    # blocco testo a destra
    text_x = margin_left + avatar_d + 70
    max_text_w = W - text_x - 60

    line1 = "L'unica AI che non sa niente."
    line2 = "Tranne Catania."
    sub = "Due chiacchiere, una risata — gratis, sul tuo telefono."

    f1 = fit_single_line(draw, line1, FONT_BOLD, max_text_w, 62, min_size=34)
    f2 = fit_single_line(draw, line2, FONT_BOLD, max_text_w, f1.size, min_size=34)
    # uniforma le due righe alla size piu' piccola tra le due
    size_claim = min(f1.size, f2.size)
    f1 = load_font(FONT_BOLD, size_claim)
    f2 = load_font(FONT_BOLD, size_claim)
    f_sub = fit_single_line(draw, sub, FONT_REGULAR, max_text_w, 30, min_size=20)
    f_domain = load_font(FONT_BOLD, 42)

    line_gap = int(size_claim * 0.18)
    sub_gap = int(size_claim * 0.55)
    _, h1, _ = text_size(draw, line1, f1)
    _, h2, _ = text_size(draw, line2, f2)
    _, hs, _ = text_size(draw, sub, f_sub)

    block_h = h1 + line_gap + h2 + sub_gap + hs
    start_y = avatar_cy - block_h // 2

    y = start_y
    draw_text_lr(draw, (text_x, y), line1, f1, WHITE)
    y += h1 + line_gap
    draw_text_lr(draw, (text_x, y), line2, f2, ORANGE2)
    y += h2 + sub_gap
    draw_text_lr(draw, (text_x, y), sub, f_sub, MUTED)

    # dominio in basso
    domain_text = domain
    _, hd, _ = text_size(draw, domain_text, f_domain)
    draw_text_lr(draw, (text_x, H - 60 - hd), domain_text, f_domain, ORANGE1)

    return canvas.convert("RGB")


def build_og_square(domain: str) -> Image.Image:
    W = H = 800
    canvas = diagonal_gradient(W, H, BG_DARK1, BG_DARK2)
    draw = ImageDraw.Draw(canvas)

    avatar_d = 300
    top_margin = 78
    avatar_cx = W // 2
    avatar_cy = top_margin + avatar_d // 2

    glow = radial_glow(W, H, (avatar_cx, avatar_cy), radius=avatar_d * 1.05, color=ORANGE1, max_alpha=95)
    glow = glow.filter(ImageFilter.GaussianBlur(16))
    canvas.alpha_composite(glow)

    ring_gap = 7
    ring_thick = 6
    ring_outer_d = avatar_d + 2 * ring_gap + 2 * ring_thick
    ring = make_ring(ring_outer_d, avatar_d + 2 * ring_gap, ORANGE1, ORANGE2)
    ring_pos = (avatar_cx - ring_outer_d // 2, avatar_cy - ring_outer_d // 2)
    canvas.alpha_composite(ring, ring_pos)

    avatar = make_avatar(AVATAR_PATH, avatar_d)
    avatar_pos = (avatar_cx - avatar_d // 2, avatar_cy - avatar_d // 2)
    canvas.alpha_composite(avatar, avatar_pos)

    line1 = "L'unica AI che non sa niente."
    line2 = "Tranne Catania."
    sub = "Due chiacchiere, una risata — gratis, sul tuo telefono."

    max_text_w = W - 100

    f1 = fit_single_line(draw, line1, FONT_BOLD, max_text_w, 46, min_size=26)
    f2 = fit_single_line(draw, line2, FONT_BOLD, max_text_w, f1.size, min_size=26)
    size_claim = min(f1.size, f2.size)
    f1 = load_font(FONT_BOLD, size_claim)
    f2 = load_font(FONT_BOLD, size_claim)
    f_sub = fit_single_line(draw, sub, FONT_REGULAR, max_text_w, 24, min_size=16)
    f_domain = load_font(FONT_BOLD, 34)

    line_gap = int(size_claim * 0.2)
    sub_gap = int(size_claim * 0.6)
    _, h1, _ = text_size(draw, line1, f1)
    _, h2, _ = text_size(draw, line2, f2)
    _, hs, _ = text_size(draw, sub, f_sub)

    content_top = avatar_cy + avatar_d // 2 + ring_gap + ring_thick + 40
    domain_h_est = f_domain.size
    bottom_margin = 60

    block_h = h1 + line_gap + h2 + sub_gap + hs
    avail = H - bottom_margin - domain_h_est - 30 - content_top
    start_y = content_top + max(0, (avail - block_h) // 2)

    def centered_x(text, font):
        w, _, _ = text_size(draw, text, font)
        return (W - w) // 2

    y = start_y
    draw.text((centered_x(line1, f1), y), line1, font=f1, fill=WHITE, anchor="la")
    y += h1 + line_gap
    draw.text((centered_x(line2, f2), y), line2, font=f2, fill=ORANGE2, anchor="la")
    y += h2 + sub_gap
    draw.text((centered_x(sub, f_sub), y), sub, font=f_sub, fill=MUTED, anchor="la")

    domain_text = domain
    dx = centered_x(domain_text, f_domain)
    _, hd, _ = text_size(draw, domain_text, f_domain)
    draw.text((dx, H - bottom_margin - hd), domain_text, font=f_domain, fill=ORANGE1, anchor="la")

    return canvas.convert("RGB")


def save_optimized(img: Image.Image, path: str, target_kb: int | None = None):
    if target_kb is None:
        img.save(path, "PNG", optimize=True)
        return
    # prova PNG ottimizzato; se troppo pesante, riduce la palette
    img.save(path, "PNG", optimize=True)
    size_kb = os.path.getsize(path) / 1024
    if size_kb <= target_kb:
        return
    quant = img.convert("P", palette=Image.ADAPTIVE, colors=256)
    quant.save(path, "PNG", optimize=True)
    size_kb = os.path.getsize(path) / 1024
    if size_kb <= target_kb:
        return
    # ultima spiaggia: meno colori
    for colors in (192, 160, 128):
        quant = img.convert("P", palette=Image.ADAPTIVE, colors=colors)
        quant.save(path, "PNG", optimize=True)
        if os.path.getsize(path) / 1024 <= target_kb:
            return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="nicu.chat")
    args = ap.parse_args()

    os.makedirs(PUBLIC, exist_ok=True)

    wide = build_og_wide(args.domain)
    wide_path = os.path.join(PUBLIC, "og.png")
    save_optimized(wide, wide_path)

    square = build_og_square(args.domain)
    square_path = os.path.join(PUBLIC, "og-square.png")
    save_optimized(square, square_path, target_kb=300)

    for path in (wide_path, square_path):
        im = Image.open(path)
        kb = os.path.getsize(path) / 1024
        print(f"{path}: {im.size[0]}x{im.size[1]} mode={im.mode} {kb:.1f} KB")


if __name__ == "__main__":
    main()
