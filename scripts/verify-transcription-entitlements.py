"""The native transcription helper requires no entitlements, including JIT."""
import pathlib,plistlib,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
helper=root/'release/mac-arm64/TalkWeaver.app/Contents/Helpers/transcription'
p=subprocess.run(['/usr/bin/codesign','-d','--entitlements',':-',str(helper)],capture_output=True,check=True)
entitlements=plistlib.loads(p.stdout) if p.stdout.strip() else {}
assert entitlements=={}, 'Transcription helper must have an empty entitlement dictionary'
print('PASS packaged transcription helper: empty entitlement dictionary')
