# Model Card — Nicu 1.2

## Description

Nicu is a small decoder-only transformer language model (20.6M parameters)
trained from scratch to portray a single fictional character: a friendly guy
from Catania, Sicily. It is not a fine-tune of an existing pretrained model —
the weights were randomly initialized and trained end-to-end on a synthetic,
character-specific dialogue corpus, then preference-tuned (DPO). This is the
model behind [nicu.chat](https://nicu.chat) (Nicu 1.2). It is small enough to
run on a server with no GPU, or in a web browser (ONNX Runtime Web, WASM).

## Architecture

nanoGPT-style decoder-only transformer.

| | |
|---|---|
| Parameters | 20.6M |
| Layers / heads / embedding dim | 15 / 8 / 320 |
| Vocabulary | 6,000 (ByteLevel BPE, trained on the model's own corpus) |
| Context window | 512 tokens |
| Export | ONNX opset 17, dynamic int8 |
| Files | with KV cache (~24 MB, served by default) and without (~24 MB, fallback) |

The int8 export costs +0.015 cross-entropy on Nicu's own lines compared with
the fp32 weights.

## Training data

A synthetic dataset of **929,500 dialogues** (133M tokens) distilled from a
much larger teacher LLM, guided by a "character sheet" that fixes the
character's identity, voice, recurring moves, and — critically — the boundary
of what he knows:

- ~565k short exchanges, after a cleanup pass (typography, dialect, dedup);
- ~365k longer, multi-turn dialogues, produced by a generator model fine-tuned
  on the teacher's dialogues.

Dialogues are Italian, with a Sicilian/Catania-dialect flavor in vocabulary
and references (food, places, expressions). The corpus mixes in-character
exchanges (Catania, food, friends, local life) with out-of-domain prompts
paired with example deflections, so the model learns to redirect rather than
answer when a question falls outside the character's world — no real-world
factual QA data is included. Loss is not computed on the simulated user's
lines: the model learns Nicu's side only.

## Preference tuning

Two rounds of DPO on top of the model trained from scratch. In each round
the model wrote 8 candidate answers for 3,000 conversation contexts; LLM judges
(anonymized) marked each answer as pass or fail, and pass/fail pairs from the same context became preference pairs
(β = 0.1, plus a likelihood term on the preferred answer). The second round stopped
at the point where further gains fell within seed-to-seed noise.

## Evaluation

Blind LLM-judge pass rate over a 204-case character-fidelity suite (identity,
substance, multi-turn coherence, boundary handling), mean of two sampling
seeds:

| Model | Pass rate |
|---|---|
| Before preference tuning | 68.2% |
| **Nicu 1.2** (after two DPO rounds) | **81.4%** |

Both were measured in the same round. The earlier 20M release (v1.0, trained on
the 565k-dialogue corpus alone) scored 69.6% under a previous judging round; the
numbers of different rounds are not directly comparable.

## Prompt format

Plain dialogue text, no special tokens beyond `<|endoftext|>` (id 0). The
prompt holds as many recent turns as fit in the 512-token window, leaving 55
tokens for the reply:

```
Utente: Ciao Nicu! Chi sei?
Nicu:
```

The site samples with temperature 1.0, top-p 0.92 and a repetition penalty of
1.15 applied only to the current turn and the generated tokens (never to the
history); generation stops on `<|endoftext|>`, on a generated `\nUtente:` /
`\nNicu:` line, or after 200 new tokens.

## Intended use

Entertainment / companion chat: a toy character-AI to talk to for fun, in a
fixed persona. Suitable for demos of small from-scratch language models and for
showing that a well-defined toy corpus + small architecture can produce a
consistent character voice.

Not intended for: factual question answering, assistant/productivity tasks,
any use where reliability of information matters.

## Limitations

- **Knows only its small world.** Facts about Catania, food, and the
  character's immediate surroundings are the only things it can speak to with
  any consistency; everything else it will deflect on rather than answer.
- **Not factual, even in-domain.** It is a small generative model trained on
  synthetic dialogue, not a knowledge base — treat anything it says as
  in-character flavor, not verified information.
- **Weak memory of the conversation.** Preference tuning improved how Nicu
  answers, not what he can recall: remembering a detail the user gave earlier
  works in only about a third of the suite's recall cases.
- **Italian only** (with Sicilian dialect elements). No other language
  support.
- **Short context** (512 tokens): long conversations will lose earlier turns.
- **Small-model artifacts**: occasional repetition, non-sequiturs, or
  grammatical slips, especially at higher sampling temperature.

## Earlier releases

The smaller models of the first family (5.3M and 9.6M parameters, trained on
the 565k-dialogue corpus without preference tuning) remain on the Hub as
[nicu-5m](https://huggingface.co/federico-anastasi/nicu-5m) and
[nicu-9m](https://huggingface.co/federico-anastasi/nicu-9m). The v1.0 release of
the 20M model is kept as the `v1.0` revision of
[nicu-20m](https://huggingface.co/federico-anastasi/nicu-20m).

## License

CC-BY-NC-4.0 — non-commercial use, attribution required. (The code that serves
this model is licensed separately, AGPL-3.0-or-later; see the main repository.)
