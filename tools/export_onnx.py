"""export_onnx.py — esporta un checkpoint Nicu in ONNX per l'inferenza in-browser.

Esporta il forward del nano (idx [B,T] -> logits [B,T,vocab]) con asse-sequenza DINAMICO
(fino a block_size). Verifica la PARITA' con PyTorch su input casuali, poi opzionalmente
quantizza int8 (onnxruntime) e ri-verifica.

Uso:  python export_onnx.py --ckpt out/nicu-M-v7.pt [--int8]
"""
from __future__ import annotations
import argparse, sys
from pathlib import Path
import torch
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from model import GPT

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="out/nicu-M-v7.pt")
    ap.add_argument("--out", default=None)
    ap.add_argument("--int8", action="store_true")
    ap.add_argument("--opset", type=int, default=17)
    a = ap.parse_args()

    ckpt = torch.load(a.ckpt, map_location="cpu", weights_only=False)
    model = GPT(ckpt["cfg"]).eval()
    model.load_state_dict(ckpt["model_state"])
    block = model.cfg.block_size
    name = Path(a.ckpt).stem.lower()
    out_fp32 = Path(a.out) if a.out else HERE / "out" / f"{name}.onnx"

    # dummy: una sequenza corta; dim 1 (tempo) dinamica fino a block
    T0 = 16
    dummy = torch.randint(0, model.cfg.vocab_size, (1, T0), dtype=torch.long)

    class Wrap(torch.nn.Module):
        def __init__(self, m): super().__init__(); self.m = m
        def forward(self, idx):
            logits, _ = self.m(idx)   # [B,T,vocab]
            return logits

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
