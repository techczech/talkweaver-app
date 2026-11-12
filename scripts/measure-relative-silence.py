"""Rescan fetched public corpus without rerunning ASR. Verify original audio hashes."""
import hashlib,json,pathlib,subprocess,tempfile,sys
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
helper=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root/'native/transcription'
(out/'relative-helper-sha256.txt').write_text(hashlib.sha256(helper.read_bytes()).hexdigest()+'\n')
with tempfile.TemporaryDirectory(prefix='.tw-relative-',dir=root) as td:
    td=pathlib.Path(td)
    for language in ['english','czech']:
        for ref in json.loads((out/f'reference-{language}.json').read_text()):
            audio=root/ref['audio']
            assert hashlib.sha256(audio.read_bytes()).hexdigest()==ref['audioSha256'], ref['id']
            raw=json.loads((out/(ref['id']+'-native.json')).read_text())
            wav=td/'audio.wav'; words=td/'words.json'
            words.write_text(json.dumps(raw['words']))
            subprocess.run([str(root/'node_modules/ffmpeg-static/ffmpeg'),'-v','error','-y','-i',str(audio),'-ac','1','-ar','16000',str(wav)],check=True,capture_output=True)
            p=subprocess.run([str(helper),'--annotate',str(wav),ref['locale'],str(words)],check=True,capture_output=True,text=True)
            raw['silence']=json.loads(p.stdout)['silence']
            (out/(ref['id']+'-relative.json')).write_text(json.dumps(raw,ensure_ascii=False,indent=2)+'\n')
            print(ref['id'],len(raw['silence']),flush=True)
