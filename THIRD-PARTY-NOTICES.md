# Third-party notices

TalkWeaver's own code is under the MIT licence (`LICENSE`). These parts come from other people,
ship inside the app and keep their own licences.

## FFmpeg

TalkWeaver runs FFmpeg as a separate program to prepare recordings for transcription. It is not
linked into TalkWeaver. It ships in the app's resources folder as `ffmpeg/ffmpeg` (macOS) or
`ffmpeg/ffmpeg.exe` (Windows), with its licence text beside it.

- **macOS (Apple silicon):** FFmpeg 9.0.2, the static build published by Martin Riedl, configured
  `--enable-gpl --enable-version3` without `--enable-nonfree`. GNU GPL v3 or later. Downloaded from
  https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip and pinned by its
  SHA-256 in `scripts/lib/ffmpeg-mac-pin.json`. Shipped with `COPYING.GPLv3` and
  `FFMPEG-NOTICE.md` (`resources/ffmpeg-mac/` in this repository). The complete corresponding
  source for this build (FFmpeg, Martin Riedl's build scripts at commit
  `6a611e19870e197bc37c6e4c7fccddebd3715466`, and the source of every library linked into it) is
  attached to the same GitHub release the app was downloaded from, beside the app, as
  `TalkWeaver-<version>-ffmpeg-9.0.2-corresponding-source.tar`. Public builds are published at
  https://github.com/techczech/talkweaver-app/releases.
- **Windows (x64):** the FFmpeg essentials build by gyan.dev that the `ffmpeg-static` npm package
  (5.3.0) downloads. GNU GPL v3. Shipped with the licence and readme files that package provides.

## Fonts

Fraunces, Alegreya Sans and JetBrains Mono, under the SIL Open Font License 1.1. Details:
`src/renderer/src/assets/fonts/LICENCE-NOTE.md`.

## Transcription script

`resources/agent-setup/transcription/parakeet_to_srt.py` is Dominik Lukeš's own work and ships under
TalkWeaver's MIT licence (`resources/agent-setup/transcription/PROVENANCE.md`).
