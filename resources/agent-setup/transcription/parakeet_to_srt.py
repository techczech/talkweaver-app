#!/usr/bin/env python3
"""Generate SRT subtitles from audio using Parakeet MLX."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Chunked by default: a single whole-file pass allocates attention buffers proportional to the
# full recording (a 28-min talk ≈ GBs of Metal memory) and intermittently dies with
# "[METAL] Command buffer execution failed: GPU Address Fault" when anything else (e.g. an
# Electron app's GPU processes) is competing for the GPU. 120s chunks with parakeet-mlx's own
# 15s overlap merge keep peak allocation small and flat regardless of recording length.
DEFAULT_CHUNK_SECONDS = 120.0


def format_timestamp_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


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
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate SRT subtitles from audio with Parakeet MLX.")
    parser.add_argument("audio", type=Path, help="Input audio file")
    parser.add_argument("-o", "--output", type=Path, help="Output .srt path")
    parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3", help="Parakeet model ID")
    parser.add_argument(
        "--chunk-seconds",
        type=float,
        default=DEFAULT_CHUNK_SECONDS,
        help="Chunk length for long recordings (0 = whole file in one pass)",
    )
    args = parser.parse_args()
    try:
        transcribe_to_srt(args.audio, args.output, args.model, args.chunk_seconds)
    except Exception as e:  # noqa: BLE001
        print(f"Transcription failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
