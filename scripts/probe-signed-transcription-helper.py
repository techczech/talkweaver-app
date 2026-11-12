"""Execute the owned signed helper on two public clips; never launch the app."""
import json,pathlib,subprocess,tempfile
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
helper=root/'release/mac-arm64/TalkWeaver.app/Contents/Helpers/transcription'
results=[]
with tempfile.TemporaryDirectory(prefix='.tw-signed-speech-',dir=root) as td:
    for name,clip,locale in [('english','84-121123-0002.flac','en-US'),('czech','czech-66.wav','cs-CZ')]:
        wav=pathlib.Path(td)/(name+'.wav')
        subprocess.run([str(root/'node_modules/ffmpeg-static/ffmpeg'),'-v','error','-y','-i',str(root/'.tw-cut-study'/clip),'-ac','1','-ar','16000',str(wav)],check=True,capture_output=True)
        p=subprocess.run([str(helper),str(wav),locale],capture_output=True,text=True,timeout=600)
        (out/f'signed-helper-{name}.stderr').write_text(p.stderr)
        if p.returncode: raise RuntimeError(f'Signed public {name} probe failed: exit {p.returncode}')
        data=json.loads(p.stdout);assert data['words'],f'No public {name} words'
        (out/f'signed-helper-{name}.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
        results.append({'source':clip,'locale':locale,'engine':data['engine'],'words':len(data['words']),'exit':p.returncode})
print(json.dumps({'result':'PASS','scope':'Developer ID signed packaged helper on this Mac; not a clean-Mac acceptance','probes':results},indent=2))
