# Model Card — Nicu

## Description

Nicu is a small decoder-only transformer language model family — three
sizes, S / M / L (5.25M-20.6M parameters) — trained from scratch to portray
a single fictional character: a friendly guy from Catania, Sicily. None of
the three is a fine-tune of an existing pretrained model — weights were
randomly initialized and each size was trained end-to-end, independently, on
the exact same synthetic, character-specific dialogue corpus. All three are
small enough to run entirely client-side in a web browser (ONNX Runtime Web,
WASM), with no server-side inference. This card covers the family; **L is
the default / recommended size** (it's the version running at the live
demo) — S and M exist mainly for size-scaling comparison and lower-end
devices.

## Architecture

nanoGPT-style decoder-only transformer. All three sizes share vocabulary
(6,000 tokens, ByteLevel BPE trained on the model's own corpus), context
window (512 tokens), and export format (ONNX, opset 17, fp32 + dynamic
int8 — the int8 export was judged blind against fp32 on a 204-case
character-fidelity suite with no measurable quality loss). They differ
only in depth and width:

| Size | Layers | Heads | Embedding dim | Parameters | ONNX fp32 | ONNX int8 | Hub |
|---|---|---|---|---|---|---|---|
| S | 9 | 8 | 192 | 5.3M | ~27 MB | ~8 MB | [nicu-5m](https://huggingface.co/federico-anastasi/nicu-5m) |
| M | 10 | 8 | 256 | 9.6M | ~46 MB | ~13 MB | [nicu-9m](https://huggingface.co/federico-anastasi/nicu-9m) |
| **L** (default) | 15 | 8 | 320 | 20.6M | ~91 MB | ~24 MB | [nicu-20m](https://huggingface.co/federico-anastasi/nicu-20m) |

## Training data

A synthetic dataset of ~565k dialogues distilled from a much larger teacher
LLM, guided by a "character sheet" that fixes the character's identity,
voice, recurring moves, and — critically — the boundary of what he knows.
Dialogues are Italian, with a Sicilian/Catania-dialect flavor in vocabulary
and references (food, places, expressions). The corpus mixes in-character
exchanges (Catania, food, friends, local life) with out-of-domain prompts
paired with example deflections, so the model learns to redirect rather than
answer when a question falls outside the character's world — no real-world
factual QA data is included. All three sizes (S/M/L) are trained on this
same corpus and tokenizer; the only difference between them is the
architecture (depth/width in the table above).

## Intended use

Entertainment / companion chat: a toy character-AI to talk to for fun, in a
fixed persona, running fully on-device. Suitable for demos of small
from-scratch language models and for showing that a well-defined toy corpus +
small architecture can produce a consistent character voice.

Not intended for: factual question answering, assistant/productivity tasks,
any use where reliability of information matters.

## Limitations

- **Knows only its small world.** Facts about Catania, food, and the
  character's immediate surroundings are the only things it can speak to with
  any consistency; everything else it will deflect on rather than answer.
- **Not factual, even in-domain.** It is a small generative model trained on
  synthetic dialogue, not a knowledge base — treat anything it says as
  in-character flavor, not verified information.
- **Italian only** (with Sicilian dialect elements). No other language
  support.
- **Short context** (512 tokens): long conversations will lose earlier turns.
- **Small-model artifacts**: occasional repetition, non-sequiturs, or
  grammatical slips, especially at higher sampling temperature — more
  pronounced on S/M than on L, given the smaller parameter budget.

## License

CC-BY-NC-4.0 — non-commercial use, attribution required. (The runtime code
that serves this model is MIT-licensed separately; see the main repository.)
