#!/usr/bin/env python3
"""Generate SRT subtitles (and, optionally, word timings) from audio using Parakeet MLX."""
from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path

# Chunked by default: a single whole-file pass allocates attention buffers proportional to the
# full recording (a 28-min talk ≈ GBs of Metal memory) and intermittently dies with
# "[METAL] Command buffer execution failed: GPU Address Fault" when anything else (e.g. an
# Electron app's GPU processes) is competing for the GPU. 120s chunks with parakeet-mlx's own
# 15s overlap merge keep peak allocation small and flat regardless of recording length.
DEFAULT_CHUNK_SECONDS = 120.0


def to_ms(seconds: float) -> int:
    """Whole milliseconds, rounded: the SRT and the word timings use the same value for one time."""
    return max(0, int(round(seconds * 1000)))


def format_timestamp_srt(seconds: float) -> str:
    total = to_ms(seconds)
    h, rest = divmod(total, 3_600_000)
    m, rest = divmod(rest, 60_000)
    s, ms = divmod(rest, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def is_punctuation(text: str) -> bool:
    return bool(text) and all(unicodedata.category(c).startswith("P") for c in text)


# Punctuation that closes or ends: it stays on the word before it even after a space.
CLOSING_CATEGORIES = {"Pe", "Pf"}
CLOSING_MARKS = set(",.;:!?…)]}»”’%")


def is_closing(text: str) -> bool:
    return all(c in CLOSING_MARKS or unicodedata.category(c) in CLOSING_CATEGORIES for c in text)


def assemble_words(sentences) -> list[dict]:
    """Words from aligned sub-word tokens (objects with .text, .start, .end), sentence by sentence.

    A token whose text starts with a space begins a new word (so does a sentence's first token);
    the others continue the word before them. A token that is only punctuation never stands alone:
    opening punctuation at the start of a word (an opening quote, ¿, «, an opening bracket) is held
    and put in front of the next word; any other punctuation goes on the end of the word before it.
    Opening punctuation with no word after it goes on the word before; with no word at all, it is
    dropped. Times are seconds, rounded to whole milliseconds exactly as the SRT rounds them.
    """
    words: list[dict] = []
    for sentence in sentences:
        current: dict | None = None  # the word tokens are being added to, in this sentence
        pending: dict | None = None  # opening punctuation waiting for its word
        for token in getattr(sentence, "tokens", None) or []:
            raw = token.text if isinstance(token.text, str) else ""
            text = raw.strip()
            if not text:
                continue
            at_word_start = current is None or pending is not None or raw[:1].isspace()
            if is_punctuation(text):
                if at_word_start and not is_closing(text):
                    if pending is None:
                        pending = {"text": text, "start": token.start, "end": token.end}
                    else:
                        pending["text"] += text
                        pending["end"] = max(pending["end"], token.end)
                    continue
                target = current or (words[-1] if words else None)
                if target is not None:
                    target["text"] += text
                    # A separate punctuation-only sentence does not extend the previous segment.
                    if current is not None:
                        target["end"] = max(target["end"], token.end)
                continue
            if at_word_start:
                current = {"text": text, "start": token.start, "end": token.end}
                if pending is not None:
                    current["text"] = pending["text"] + text
                    current["start"] = min(pending["start"], token.start)
                    pending = None
                words.append(current)
            else:
                current["text"] += text
                current["end"] = max(current["end"], token.end)
        if pending is not None and words:
            words[-1]["text"] += pending["text"]
            if current is not None:
                words[-1]["end"] = max(words[-1]["end"], pending["end"])
    out: list[dict] = []
    for word in words:
        start = to_ms(word["start"])
        end = max(start, to_ms(word["end"]))
        out.append({"text": word["text"], "start": start / 1000, "end": end / 1000})
    return out


def words_from_result(result) -> list[dict]:
    return assemble_words(result.sentences)


def write_words(result, words_path: Path) -> int:
    words = words_from_result(result)
    words_path.write_text(json.dumps({"words": words}, ensure_ascii=False), encoding="utf-8")
    return len(words)


def write_srt(result, output_path: Path) -> int:
    lines: list[str] = []
    for i, sentence in enumerate(result.sentences, 1):
        lines.append(str(i))
        lines.append(f"{format_timestamp_srt(sentence.start)} --> {format_timestamp_srt(sentence.end)}")
        lines.append(sentence.text.strip())
        lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")
    return len(result.sentences)


def transcribe_to_srt(
    audio_path: Path,
    output_path: Path | None = None,
    model_id: str = "mlx-community/parakeet-tdt-0.6b-v3",
    chunk_seconds: float = DEFAULT_CHUNK_SECONDS,
    words_path: Path | None = None,
):
    from parakeet_mlx import from_pretrained

    output_path = output_path or audio_path.with_suffix(".srt")
    chunk_duration = chunk_seconds if chunk_seconds > 0 else None

    def report(current: float, total: float) -> None:
        # Progress lines go to stdout so callers streaming output (e.g. TalkWeaver's
        # Transcribe panel) can show more than a silent multi-minute wait.
        print(f"Transcribing… {min(current, total) / total:.0%}", flush=True)

    def run() -> object:
        model = from_pretrained(model_id)
        return model.transcribe(
            str(audio_path),
            chunk_duration=chunk_duration,
            chunk_callback=report if chunk_duration else None,
        )

    try:
        result = run()
    except Exception as e:  # noqa: BLE001 — Metal faults surface as bare RuntimeError
        message = str(e)
        if "METAL" not in message and "Metal" not in message and "GPU" not in message:
            raise
        # GPU-pressure fault (address fault / command buffer failure). Retry once on the CPU:
        # several times slower, but immune to whatever else is squatting on the GPU.
        print(f"GPU transcription failed ({message.splitlines()[0]}); retrying on CPU…", flush=True)
        import mlx.core as mx

        mx.set_default_device(mx.cpu)
        result = run()

    count = write_srt(result, output_path)
    print(f"Saved SRT: {output_path} ({count} segments)")
    if words_path is not None:
        word_count = write_words(result, words_path)
        print(f"Saved word timings: {words_path} ({word_count} words)")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate SRT subtitles (and optionally word timings) from audio with Parakeet MLX.")
    parser.add_argument("audio", type=Path, help="Input audio file")
    parser.add_argument("-o", "--output", type=Path, help="Output .srt path")
    parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3", help="Parakeet model ID")
    parser.add_argument(
        "--chunk-seconds",
        type=float,
        default=DEFAULT_CHUNK_SECONDS,
        help="Chunk length for long recordings (0 = whole file in one pass)",
    )
    parser.add_argument(
        "--words",
        type=Path,
        metavar="WORDS_JSON",
        help='Also write word timings as JSON: {"words": [{"text", "start", "end"}]}, seconds',
    )
    args = parser.parse_args()
    try:
        transcribe_to_srt(args.audio, args.output, args.model, args.chunk_seconds, args.words)
    except Exception as e:  # noqa: BLE001
        print(f"Transcription failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
