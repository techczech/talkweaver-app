#!/bin/sh
# Build the ffmpeg program from this archive's own files with the build scripts it holds (macOS).
#
#   rebuild/build-from-bundle.sh [--prepare-only] <new work folder> [options for build.sh, e.g. -SKIP_TEST=YES]
#
# 1. checks every file of the archive against SHA256SUMS;
# 2. unpacks the build scripts (build-script/) into <work folder>/build-script;
# 3. makes their download() take each source from this archive (rebuild/fetch-from-bundle.sh): the
#    FFmpeg release, every library, and x264 at the pinned commit instead of the moving master branch;
# 4. unpacks the Rust crates rav1e is built from into <work folder>/cargo-vendor and points cargo at
#    them, offline (<work folder>/.cargo/config.toml), so cargo fetches nothing;
# 5. runs build.sh from <work folder>; the program is written to <work folder>/out/.
# With --prepare-only it stops after step 4 and prints the command for step 5.
# Requirements are those of the build scripts (build-script/README.md): Xcode command line tools,
# python3 with virtualenv (meson), rust with cargo and cargo-c. The build tools (nasm, ninja,
# pkg-config, cmake) are still downloaded by the scripts, as they are not part of the program; set
# TW_REBUILD_OFFLINE=1 to refuse every download that is not in this archive.
set -eu
PREPARE_ONLY=0
if [ "${1:-}" = "--prepare-only" ]; then PREPARE_ONLY=1; shift; fi
[ $# -ge 1 ] || { echo "usage: $0 [--prepare-only] <new work folder> [build.sh options]" >&2; exit 2; }
WORK=$1
shift
HERE=$(cd "$(dirname "$0")" && pwd)
BUNDLE=$(cd "$HERE/.." && pwd)
[ ! -e "$WORK" ] || { echo "build-from-bundle: $WORK already exists; give a new folder" >&2; exit 1; }
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)

echo "1. checking every file against SHA256SUMS"
(cd "$BUNDLE" && shasum -a 256 -c SHA256SUMS --quiet)

echo "2. unpacking the build scripts"
mkdir "$WORK/build-script"
/usr/bin/tar -xzf "$BUNDLE"/build-script/build-script-*.tar.gz -C "$WORK/build-script" --strip-components=1

echo "3. sources from this archive: download() in script/functions.sh now calls rebuild/fetch-from-bundle.sh"
cat >> "$WORK/build-script/script/functions.sh" <<EOF

# Added by build-from-bundle.sh: every source comes from the corresponding-source archive.
download(){
    "$HERE/fetch-from-bundle.sh" "\$1" "\$2"
}
EOF

echo "4. the rav1e crates, for cargo offline"
mkdir "$WORK/cargo-vendor" "$WORK/.cargo"
for CRATE in "$BUNDLE"/libraries/rav1e-crates/*.crate; do
  BASE=$(basename "$CRATE" .crate)
  SUM=$(awk -v p="libraries/rav1e-crates/$BASE.crate" '$2 == p { print $1 }' "$BUNDLE/SHA256SUMS")
  [ -n "$SUM" ] || { echo "build-from-bundle: $BASE.crate is not in SHA256SUMS" >&2; exit 1; }
  /usr/bin/tar -xzf "$CRATE" -C "$WORK/cargo-vendor"
  [ -d "$WORK/cargo-vendor/$BASE" ] || { echo "build-from-bundle: $BASE.crate did not unpack into $BASE/" >&2; exit 1; }
  printf '{"files":{},"package":"%s"}\n' "$SUM" > "$WORK/cargo-vendor/$BASE/.cargo-checksum.json"
done
cat > "$WORK/.cargo/config.toml" <<EOF
# Added by build-from-bundle.sh: the crates come from this archive, never from crates.io.
[source.crates-io]
replace-with = "corresponding-source"

[source.corresponding-source]
directory = "$WORK/cargo-vendor"

[net]
offline = true
EOF

if [ "$PREPARE_ONLY" = "1" ]; then
  echo "prepared. To build: cd \"$WORK\" && ./build-script/build.sh $*"
  exit 0
fi
echo "5. building (logs in $WORK/log/, the program in $WORK/out/)"
cd "$WORK"
exec ./build-script/build.sh "$@"
