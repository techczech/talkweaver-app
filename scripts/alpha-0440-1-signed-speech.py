"""Real signed helper, public fixture shipped in source; no speech stand-in."""
import pathlib,subprocess,json
root=pathlib.Path(__file__).resolve().parent.parent
helper=root/'release/mac-arm64/TalkWeaver.app/Contents/Helpers/transcription'
clip=root/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/fixtures/human-english.wav'
result=subprocess.run([str(helper),str(clip),'en-US'],capture_output=True,text=True,timeout=600)
(root/'evidence/alpha-0440-1/signed-speech.stderr').write_text(result.stderr)
assert result.returncode==0,f'Speech helper exited {result.returncode}; see signed-speech.stderr'
data=json.loads(result.stdout);assert data['words'],'No recognised words'
(root/'evidence/alpha-0440-1/signed-speech.json').write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps({'result':'PASS','engine':data['engine'],'words':len(data['words']),'fixture':str(clip.relative_to(root)),'scope':'signed packaged helper, separate from recording UI'}))
