# FFmpeg in TalkWeaver for macOS

The `ffmpeg` program in this folder is FFmpeg, made by the FFmpeg developers
(https://ffmpeg.org). TalkWeaver runs it as a separate program to prepare recordings for
transcription. It is not part of TalkWeaver's own code, and TalkWeaver's MIT licence does not
cover it.

- **Version:** FFmpeg 9.0.2, the static macOS build for Apple silicon (arm64) published by
  Martin Riedl.
- **Downloaded from:** https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip
- **SHA-256 of the program as published:**
  `2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384`.
  The copy in a signed TalkWeaver release is re-signed with TalkWeaver's certificate, so its own
  hash differs; nothing else in it is changed.
- **Built with:** `--enable-gpl --enable-version3`, without `--enable-nonfree`. Run
  `ffmpeg -buildconf` to see the full configuration.
- **Licence:** GNU General Public License, version 3 or later. The full text is in
  `COPYING.GPLv3`, next to this file. FFmpeg comes with no warranty.

## Getting the source code

The complete corresponding source code for this program is attached to the same GitHub release
this copy of TalkWeaver was downloaded from, beside the app itself, as the file

    TalkWeaver-<version>-ffmpeg-9.0.2-corresponding-source.tar

where `<version>` is the version of this copy of TalkWeaver. Its SHA-256 is in the file
`TalkWeaver-<version>-ffmpeg-9.0.2-corresponding-source.SHA256SUMS` in the same release. Public
builds of TalkWeaver are published at https://github.com/techczech/talkweaver-app/releases.

The archive holds:

- the FFmpeg 9.0.2 source release (`ffmpeg-9.0.2.tar.xz`, SHA-256
  `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`);
- the scripts that configured and built this program, from
  https://git.martin-riedl.de/ffmpeg/build-script at commit
  `6a611e19870e197bc37c6e4c7fccddebd3715466`;
- the source of every library built into this program, at the version this build used
  (listed in the archive's `README.txt`);
- a list of every file in it with its SHA-256 and the address it came from;
- directions and a script for building this program from the archive's own files
  (`REBUILD.txt`), without downloading the sources again.
