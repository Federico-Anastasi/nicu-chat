#!/usr/bin/env python3
"""Genera i diagrammi SVG del README (pipeline + runtime) in variante dark/light.

Un'unica fonte per geometria e testi: cambiano solo i colori. Rilanciare dopo
ogni modifica: `python assets/gen_diagrams.py` (dalla root del repo).
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))

FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

THEMES = {
    "dark": dict(
        card="#0f2040", card_stroke="#24466b", text="#e8f1f8", sub="#8fa9bf",
        accent="#f09040", accent_deep="#e86a2b", accent_text="#ffffff",
        arrow="#4a6a8c", container="#0b1830", container_stroke="#1a3a5c",
        container_label="#7a9bb5", shadow="rgba(0,0,0,0.45)",
    ),
    "light": dict(
        card="#ffffff", card_stroke="#d5e0ea", text="#16283c", sub="#5b7690",
        accent="#e86a2b", accent_deep="#c4520a", accent_text="#ffffff",
        arrow="#9db4c8", container="#f2f6fa", container_stroke="#dbe5ee",
        container_label="#5b7690", shadow="rgba(30,50,70,0.18)",
    ),
}


def svg_open(w, h, t):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'font-family="{FONT}">\n'
        f'<defs>\n'
        f'  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">\n'
        f'    <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="{t["shadow"]}"/>\n'
        f'  </filter>\n'
        f'  <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1">\n'
        f'    <stop offset="0" stop-color="{t["accent"]}"/>\n'
        f'    <stop offset="1" stop-color="{t["accent_deep"]}"/>\n'
        f'  </linearGradient>\n'
        f'  <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" '
        f'markerHeight="7" orient="auto-start-reverse">\n'
        f'    <path d="M0,0 L10,5 L0,10 z" fill="{t["accent"]}"/>\n'
        f'  </marker>\n'
        f'</defs>\n'
    )


def node(x, y, w, h, title, sub, t, accent=False):
    fill = 'url(#acc)' if accent else t["card"]
    stroke = t["accent_deep"] if accent else t["card_stroke"]
    tcol = t["accent_text"] if accent else t["text"]
    scol = 'rgba(255,255,255,0.85)' if accent else t["sub"]
    cx = x + w / 2
    return (
        f'<g filter="url(#soft)">'
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="1.5"/></g>\n'
        f'<text x="{cx}" y="{y + h / 2 - 7}" text-anchor="middle" '
        f'font-size="15.5" font-weight="600" fill="{tcol}">{title}</text>\n'
        f'<text x="{cx}" y="{y + h / 2 + 15}" text-anchor="middle" '
        f'font-size="12" fill="{scol}">{sub}</text>\n'
    )


def arrow(x1, y1, x2, y2, t):
    return (
        f'<path d="M{x1},{y1} L{x2},{y2}" stroke="{t["arrow"]}" '
        f'stroke-width="2" fill="none" marker-end="url(#arr)"/>\n'
    )


def elbow(x1, y1, x2, y2, t):
    """Connettore verticale con curva morbida (serpentina)."""
    my = (y1 + y2) / 2
    return (
        f'<path d="M{x1},{y1} C{x1},{my} {x2},{my} {x2},{y2 - 4}" '
        f'stroke="{t["arrow"]}" stroke-width="2" fill="none" marker-end="url(#arr)"/>\n'
    )


# ---------------------------------------------------------------------------
# Pipeline: 8 tappe in serpentina (4 + 4)
# ---------------------------------------------------------------------------

def pipeline(t):
    W, H = 960, 320
    NW, NH = 212, 86
    xs = [14, 252, 490, 728]
    y1, y2 = 30, 196
    s = svg_open(W, H, t)

    row1 = [
        ("Character sheet", "identity · voice · boundaries"),
        ("Teacher LLM", "writes in-character dialogues"),
        ("Synthetic corpus", "~930k dialogues"),
        ("Quality filter", "typography · dialect · dedup"),
    ]
    row2 = [  # da destra verso sinistra
        ("BPE tokenizer", "ByteLevel · 6k vocab"),
        ("Train from scratch", "20M parameters · 15 layers"),
        ("Preference tuning", "DPO on judged answers"),
        ("ONNX int8 · 24 MB", "server by default · or on-device"),
    ]

    for i, (title, sub) in enumerate(row1):
        s += node(xs[i], y1, NW, NH, title, sub, t)
        if i < 3:
            s += arrow(xs[i] + NW + 3, y1 + NH / 2, xs[i + 1] - 5, y1 + NH / 2, t)

    for i, (title, sub) in enumerate(row2):
        x = xs[3 - i]
        s += node(x, y2, NW, NH, title, sub, t, accent=(i == 3))
        if i < 3:
            s += arrow(x - 3, y2 + NH / 2, x - (xs[1] - xs[0]) + NW + 5, y2 + NH / 2, t)

    # connettore serpentina: Quality filter ↓ BPE tokenizer
    s += elbow(xs[3] + NW / 2, y1 + NH + 2, xs[3] + NW / 2, y2, t)

    return s + '</svg>\n'


# ---------------------------------------------------------------------------
# Runtime: chat UI -> server (default) oppure Web Worker sul dispositivo
# ---------------------------------------------------------------------------

def runtime(t):
    W, H = 960, 430
    s = svg_open(W, H, t)

    def container(x, y, w, h, label):
        return (
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" '
            f'fill="{t["container"]}" stroke="{t["container_stroke"]}" '
            f'stroke-width="1.5" stroke-dasharray="6 5"/>\n'
            f'<text x="{x + 20}" y="{y + 30}" font-size="12.5" font-weight="700" '
            f'letter-spacing="1.5" fill="{t["container_label"]}">{label}</text>\n'
        )

    def label(x, y, text):
        return (
            f'<text x="{x}" y="{y}" text-anchor="middle" font-size="12" '
            f'fill="{t["sub"]}">{text}</text>\n'
        )

    # browser
    s += container(20, 24, 260, 352, 'BROWSER')
    s += node(40, 170, 220, 96, 'React chat UI', 'streams tokens into the bubble', t)

    # server (predefinito)
    s += container(420, 24, 520, 168, 'SERVER · DEFAULT')
    s += node(440, 62, 228, 108, 'nicu-infer', 'rate limit · queue · SSE stream', t)
    s += arrow(670, 116, 702, 116, t)
    s += node(704, 62, 216, 108, '4 worker processes', 'ONNX Runtime Node · KV cache', t, accent=True)

    # dispositivo (opzionale)
    s += container(420, 208, 520, 168, 'ON YOUR DEVICE · OPTIONAL')
    s += node(440, 246, 228, 108, 'Web Worker', 'off the UI thread', t)
    s += arrow(670, 300, 702, 300, t)
    s += node(704, 246, 216, 108, 'ONNX Runtime Web', 'WASM · model kept in cache', t, accent=True)

    # frecce tra i due mondi
    s += arrow(262, 200, 418, 116, t)
    s += label(340, 132, 'POST /api/chat')
    s += arrow(262, 236, 418, 300, t)
    s += label(340, 300, 'postMessage')

    # nucleo condiviso
    s += (
        f'<rect x="20" y="392" width="920" height="30" rx="10" fill="{t["card"]}" '
        f'stroke="{t["card_stroke"]}" stroke-width="1.5"/>\n'
        f'<text x="480" y="412" text-anchor="middle" font-size="12.5" fill="{t["text"]}">'
        f'same core on both sides (web/src/core): BPE tokenizer · prompt window · sampling · generation loop</text>\n'
    )

    return s + '</svg>\n'


for name, fn in (("pipeline", pipeline), ("runtime", runtime)):
    for theme, colors in THEMES.items():
        path = os.path.join(HERE, f'{name}-{theme}.svg')
        io.open(path, 'w', encoding='utf-8', newline='\n').write(fn(colors))
        print('scritto', path)
