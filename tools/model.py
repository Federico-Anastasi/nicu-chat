"""model.py — il GPT di Nicu (decoder-only in stile nanoGPT), autonomo: dipende solo da PyTorch.

È la definizione che serve a `export_onnx.py` per caricare un checkpoint. Con `use_cache=True` il
forward restituisce anche le coppie (k, v) di ogni strato, per l'export con KV cache.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
from torch.nn import functional as F


@dataclass
class GPTConfig:
    vocab_size: int = 65
    block_size: int = 128
    n_layer: int = 4
    n_head: int = 4
    n_embd: int = 128
    dropout: float = 0.1


class CausalSelfAttention(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        assert cfg.n_embd % cfg.n_head == 0
        self.n_head = cfg.n_head
        self.n_embd = cfg.n_embd
        self.c_attn = nn.Linear(cfg.n_embd, 3 * cfg.n_embd)
        self.c_proj = nn.Linear(cfg.n_embd, cfg.n_embd)
        self.attn_drop = nn.Dropout(cfg.dropout)
        self.resid_drop = nn.Dropout(cfg.dropout)
        # causal mask
        mask = torch.tril(torch.ones(cfg.block_size, cfg.block_size))
        self.register_buffer("mask", mask.view(1, 1, cfg.block_size, cfg.block_size))

    def forward(self, x, past=None, use_cache: bool = False):
        """past: (k, v) dei token gia' visti, ciascuno [B, n_head, P, hs].

        ⚠️ Con la cache la maschera causale NON e' `mask[:T,:T]`: la query in posizione P+i deve
        poter vedere tutti i P token passati piu' i primi i nuovi -> `mask[P:P+T, :P+T]`.
        Usare la fetta sbagliata non da' errore, da' un modello che ignora il passato.
        """
        B, T, C = x.shape
        q, k, v = self.c_attn(x).split(self.n_embd, dim=2)
        hs = C // self.n_head
        q = q.view(B, T, self.n_head, hs).transpose(1, 2)
        k = k.view(B, T, self.n_head, hs).transpose(1, 2)
        v = v.view(B, T, self.n_head, hs).transpose(1, 2)
        P = 0
        if past is not None:
            pk, pv = past
            P = pk.shape[2]
            k = torch.cat((pk, k), dim=2)
            v = torch.cat((pv, v), dim=2)
        present = (k, v) if use_cache else None
        att = (q @ k.transpose(-2, -1)) * (1.0 / math.sqrt(hs))
        att = att.masked_fill(self.mask[:, :, P:P + T, :P + T] == 0, float("-inf"))
        att = self.attn_drop(F.softmax(att, dim=-1))
        y = att @ v
        y = y.transpose(1, 2).contiguous().view(B, T, C)
        y = self.resid_drop(self.c_proj(y))
        return (y, present) if use_cache else y


class MLP(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.c_fc = nn.Linear(cfg.n_embd, 4 * cfg.n_embd)
        self.c_proj = nn.Linear(4 * cfg.n_embd, cfg.n_embd)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x):
        return self.drop(self.c_proj(F.gelu(self.c_fc(x))))


class Block(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.ln1 = nn.LayerNorm(cfg.n_embd)
        self.attn = CausalSelfAttention(cfg)
        self.ln2 = nn.LayerNorm(cfg.n_embd)
        self.mlp = MLP(cfg)

    def forward(self, x, past=None, use_cache: bool = False):
        if use_cache:
            a, present = self.attn(self.ln1(x), past=past, use_cache=True)
            x = x + a
            x = x + self.mlp(self.ln2(x))
            return x, present
        x = x + self.attn(self.ln1(x))
        x = x + self.mlp(self.ln2(x))
        return x


class GPT(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.cfg = cfg
        self.tok_emb = nn.Embedding(cfg.vocab_size, cfg.n_embd)
        self.pos_emb = nn.Embedding(cfg.block_size, cfg.n_embd)
        self.drop = nn.Dropout(cfg.dropout)
        self.blocks = nn.ModuleList([Block(cfg) for _ in range(cfg.n_layer)])
        self.ln_f = nn.LayerNorm(cfg.n_embd)
        self.head = nn.Linear(cfg.n_embd, cfg.vocab_size, bias=False)
        # weight tying
        self.head.weight = self.tok_emb.weight
        self.apply(self._init)

    def _init(self, m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
            if m.bias is not None:
                nn.init.zeros_(m.bias)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)

    def num_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def forward(self, idx, targets=None, past=None, use_cache: bool = False):
        """use_cache=False -> comportamento storico identico, ritorna (logits, loss).
        use_cache=True   -> ritorna (logits, loss, presents): la generazione passa solo il token
        nuovo invece di tutta la sequenza. Senza cache ogni token rigenera tutto: la latenza
        cresce 5,3× da 40 a 300 token di contesto.

        ⚠️ Con la cache le posizioni partono da P, non da 0: `pos = arange(P, P+T)`. Sbagliare
        questo non solleva errori, produce solo testo peggiore — il modello legge le posizioni
        sfasate.
        """
        B, T = idx.shape
        P = past[0][0].shape[2] if past is not None else 0
        pos = torch.arange(P, P + T, device=idx.device)
        x = self.drop(self.tok_emb(idx) + self.pos_emb(pos))
        if use_cache:
            presents = []
            for i, blk in enumerate(self.blocks):
                x, pr = blk(x, past=(past[i] if past is not None else None), use_cache=True)
                presents.append(pr)
        else:
            for blk in self.blocks:
                x = blk(x)
        x = self.ln_f(x)
        logits = self.head(x)
        loss = None
        if targets is not None:
            # ignore_index=-100: i target mascherati (prompt utente) NON producono gradiente.
            # Il contesto resta visibile in input — l'attenzione lo legge — semplicemente non
            # si impara a predirlo.
            # ⚠️ La loss cosi' calcolata NON e' confrontabile con le run senza maschera:
            # cambia il denominatore. Il verdetto lo da' il giudice.
            loss = F.cross_entropy(logits.reshape(-1, logits.size(-1)),
                                   targets.reshape(-1), ignore_index=-100)
        if use_cache:
            return logits, loss, presents
        return logits, loss

    @torch.no_grad()
    def generate(self, idx, max_new_tokens, temperature=1.0, top_k=None):
        for _ in range(max_new_tokens):
            idx_cond = idx[:, -self.cfg.block_size:]
            logits, _ = self(idx_cond)
            logits = logits[:, -1, :] / temperature
            if top_k is not None:
                v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < v[:, [-1]]] = float("-inf")
            probs = F.softmax(logits, dim=-1)
            nxt = torch.multinomial(probs, num_samples=1)
            idx = torch.cat((idx, nxt), dim=1)
        return idx
