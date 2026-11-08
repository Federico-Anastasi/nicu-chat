"""export_onnx.py — esporta un checkpoint Nicu in ONNX per l'inferenza in-browser.

Esporta il forward del nano (idx [B,T] -> logits [B,T,vocab]) con asse-sequenza DINAMICO
(fino a block_size). Verifica la PARITA' con PyTorch su input casuali, poi opzionalmente
quantizza int8 (onnxruntime) e ri-verifica.

Uso:  python export_onnx.py --ckpt nicu-L.pt [--int8] [--kv-cache]

nicu.chat serve due file int8: quello con KV cache (`--int8 --kv-cache`, il predefinito) e quello
senza cache (`--int8`, di ripiego).
"""
from __future__ import annotations
import argparse, sys

try:  # console Windows in cp1252: senza questo i print con simboli non-ASCII crashano
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
from pathlib import Path
import torch
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from model import GPT

def export_kv(a, model, block: int, out: Path):
    """Export con KV cache: input `idx` + `past_k_i`/`past_v_i` per layer, output `logits` +
    `present_k_i`/`present_v_i`. Il primo passo (prefill) si fa con past di lunghezza 0.

    ⚠️ Un past a lunghezza 0 va passato comunque come tensore vuoto [B,h,0,hs]: ONNX non ha input
    opzionali veri, e l'alternativa (due grafi, prefill e decode) raddoppia il file da scaricare.
    """
    import numpy as np
    import onnxruntime as ort

    cfg = model.cfg
    nl, nh, hs = cfg.n_layer, cfg.n_head, cfg.n_embd // cfg.n_head

    class WrapKV(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, idx, *flat):
            past = None
            if flat and flat[0].shape[2] > 0:
                past = [(flat[2 * i], flat[2 * i + 1]) for i in range(len(flat) // 2)]
            logits, _, presents = self.m(idx, past=past, use_cache=True)
            fuori = [logits]
            for k, v in presents:
                fuori += [k, v]
            return tuple(fuori)

    in_names = ["idx"] + [f"past_{t}_{i}" for i in range(nl) for t in ("k", "v")]
    out_names = ["logits"] + [f"present_{t}_{i}" for i in range(nl) for t in ("k", "v")]
    axes = {"idx": {0: "batch", 1: "seq"}, "logits": {0: "batch", 1: "seq"}}
    for n in in_names[1:]:
        axes[n] = {0: "batch", 2: "past"}
    for n in out_names[1:]:
        axes[n] = {0: "batch", 2: "tot"}

    T0, P0 = 4, 6
    dummy_idx = torch.randint(0, cfg.vocab_size, (1, T0), dtype=torch.long)
    dummy_past = [torch.zeros(1, nh, P0, hs) for _ in range(2 * nl)]

    print(f"[onnx-kv] export {a.ckpt} ({model.num_params():,} param, {nl} layer) -> {out.name}",
          flush=True)
    torch.onnx.export(
        WrapKV(model), (dummy_idx, *dummy_past), str(out),
        input_names=in_names, output_names=out_names, dynamic_axes=axes,
        opset_version=a.opset, do_constant_folding=True,
    )
    model.eval()

    # --- verifica: generazione incrementale con cache == forward pieno ---
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    idx = torch.randint(0, cfg.vocab_size, (1, 40), dtype=torch.long)
    with torch.no_grad():
        rif = model(idx)[0][:, -1].numpy()

    feeds = {"idx": idx[:, :20].numpy().astype(np.int64)}
    for n in in_names[1:]:
        feeds[n] = np.zeros((1, nh, 0, hs), dtype=np.float32)
    got = sess.run(out_names, feeds)
    for t in range(20, 40):
        feeds = {"idx": idx[:, t:t + 1].numpy().astype(np.int64)}
        for j, n in enumerate(in_names[1:]):
            feeds[n] = got[1 + j]
        got = sess.run(out_names, feeds)
    d = float(np.abs(rif - got[0][:, -1]).max())
    mb = out.stat().st_size / 1e6
    print(f"[onnx-kv] {out.name}  {mb:.1f} MB  | Δ vs forward pieno = {d:.2e}  "
          f"({'OK' if d < 1e-3 else '⛔ CACHE ROTTA'})", flush=True)

    if a.int8:
        from onnxruntime.quantization import quantize_dynamic, QuantType
        out8 = out.with_suffix(".int8.onnx")
        quantize_dynamic(str(out), str(out8), weight_type=QuantType.QInt8)
        print(f"[onnx-kv] int8 -> {out8.name}  {out8.stat().st_size/1e6:.1f} MB", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--int8", action="store_true")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--kv-cache", action="store_true",
                    help="esporta con past/present per ogni layer: la generazione passa SOLO il "
                         "token nuovo invece di tutta la sequenza. Senza cache la latenza cresce "
                         "5,3x da 40 a 300 token di contesto.")
    a = ap.parse_args()

    ckpt = torch.load(a.ckpt, map_location="cpu", weights_only=False)
    model = GPT(ckpt["cfg"]).eval()
    model.load_state_dict(ckpt["model_state"])
    block = model.cfg.block_size
    name = Path(a.ckpt).stem.lower()
    out_fp32 = Path(a.out) if a.out else Path(a.ckpt).resolve().with_name(f"{name}.onnx")

    # dummy: una sequenza corta; dim 1 (tempo) dinamica fino a block
    T0 = 16
    dummy = torch.randint(0, model.cfg.vocab_size, (1, T0), dtype=torch.long)

    class Wrap(torch.nn.Module):
        def __init__(self, m): super().__init__(); self.m = m
        def forward(self, idx):
            logits, _ = self.m(idx)   # [B,T,vocab]
            return logits

    if a.kv_cache:
        return export_kv(a, model, block, out_fp32.with_name(out_fp32.stem + ".kv.onnx"))

    print(f"[onnx] export {a.ckpt} ({model.num_params():,} param, block {block}) -> {out_fp32.name}", flush=True)
    torch.onnx.export(
        Wrap(model), (dummy,), str(out_fp32),
        input_names=["idx"], output_names=["logits"],
        dynamic_axes={"idx": {0: "batch", 1: "seq"}, "logits": {0: "batch", 1: "seq"}},
        # folding ON: senza, i pesi restano nodi Constant (non initializer) e
        # quantize_dynamic non li tocca -> int8 "finto" (84->77 MB invece di 84->24).
        opset_version=a.opset, do_constant_folding=True,
    )

    # --- verifica parita' (PyTorch vs onnxruntime) su piu' lunghezze ---
    # ri-assicura eval: torch.onnx.export RIPRISTINA lo stato di training del
    # wrapper a fine export e puo' riattivare il dropout -> parita' falsata
    # (visto con L 15 strati: delta ~18 finti; il file .onnx era corretto)
    model.eval()
    import onnxruntime as ort
    sess = ort.InferenceSession(str(out_fp32), providers=["CPUExecutionProvider"])
    worst = 0.0
    for T in (1, 7, 32, 128, block):
        x = torch.randint(0, model.cfg.vocab_size, (1, T), dtype=torch.long)
        with torch.no_grad():
            ref = model(x)[0].numpy()
        got = sess.run(["logits"], {"idx": x.numpy().astype(np.int64)})[0]
        d = float(np.abs(ref - got).max())
        worst = max(worst, d)
        print(f"[onnx]  T={T:>4}  max|Δ logits| = {d:.2e}")
    mb = out_fp32.stat().st_size / 1e6
    print(f"[onnx] fp32 -> {out_fp32.name}  {mb:.1f} MB  | parita' max Δ = {worst:.2e}  "
          f"({'OK' if worst < 1e-3 else 'ATTENZIONE'})", flush=True)

    if a.int8:
        from onnxruntime.quantization import quantize_dynamic, QuantType
        out_int8 = out_fp32.with_suffix(".int8.onnx")
        quantize_dynamic(str(out_fp32), str(out_int8), weight_type=QuantType.QInt8)
        sess8 = ort.InferenceSession(str(out_int8), providers=["CPUExecutionProvider"])
        x = torch.randint(0, model.cfg.vocab_size, (1, 64), dtype=torch.long)
        with torch.no_grad():
            ref = model(x)[0].numpy()
        got = sess8.run(["logits"], {"idx": x.numpy().astype(np.int64)})[0]
        d = float(np.abs(ref - got).max())
        mb8 = out_int8.stat().st_size / 1e6
        print(f"[onnx] int8 -> {out_int8.name}  {mb8:.1f} MB  | Δ vs fp32(torch) = {d:.2e}", flush=True)

if __name__ == "__main__":
    main()
