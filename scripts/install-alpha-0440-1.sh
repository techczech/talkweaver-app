#!/bin/bash
# Coordinator only, after publication of 0.43.0. Does not launch or quit an app.
set -euo pipefail
source_app=${1:?Usage: install-alpha-0440-1.sh /absolute/path/TalkWeaver.app}
target="/Applications/TalkWeaver.app"  # where TalkWeaver is installed on the Pro and the Air; backups go to ~/Applications
expected_cdhash='1f6340a141886e5ea64c3a0e099e805dbcf4538f'
[ "$expected_cdhash" != 'PENDING_FINAL_VERIFICATION' ] || { echo 'STOP: final signed alpha has not yet been verified.'; exit 1; }
version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$source_app/Contents/Info.plist")
[ "$version" = '0.44.0-alpha.1' ] || { echo "Wrong candidate version: $version"; exit 1; }
/usr/bin/codesign --verify --deep --strict "$source_app"
signature_info=$(/usr/bin/codesign -dvvv "$source_app" 2>&1)
case "$signature_info" in *'TeamIdentifier=M7H45AGG8A'*) ;; *) echo 'Wrong signing team'; exit 1;; esac
candidate_cdhash=$(printf '%s\n' "$signature_info" | /usr/bin/sed -n 's/^CDHash=//p')
[ "$candidate_cdhash" = "$expected_cdhash" ] || { echo 'STOP: this is not the verified final alpha bundle.'; exit 1; }
assert_closed() {
  if /usr/bin/pgrep -x TalkWeaver >/dev/null || /usr/bin/pgrep -f '/TalkWeaver.app/Contents/' >/dev/null; then
    echo 'STOP: TalkWeaver is running. Leave it open; arrange installation when the owner has closed it.'
    exit 1
  fi
}
assert_closed
mkdir -p "$HOME/Applications"
stamp=$(date '+%Y%m%d-%H%M%S')
backup="$HOME/Applications/TalkWeaver-before-alpha-0440-1-$stamp.app"
[ ! -e "$backup" ]
if [ -e "$target" ]; then
  current_version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$target/Contents/Info.plist")
  echo "Current version: $current_version"
  case "$current_version" in
    0.43.0|0.43.0-alpha.7) ;;
    *) echo 'STOP: expected 0.43.0 or 0.43.0-alpha.7. Coordinator must check the installed source and features before choosing a replacement.'; exit 1;;
  esac
  assert_closed
  mv "$target" "$backup"
  echo "Retained previous app: $backup"
fi
assert_closed
/usr/bin/ditto "$source_app" "$target"
/usr/bin/codesign --verify --deep --strict "$target"
[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$target/Contents/Info.plist")" = '0.44.0-alpha.1' ]
echo 'Installed 0.44.0-alpha.1; not launched. Existing data and account connections retained.'
