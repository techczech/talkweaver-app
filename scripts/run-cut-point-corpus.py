"""Run only the fetched public corpus, inside agent-run; preserve raw JSON and exits."""
import hashlib,json,pathlib,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent.parent
OUT=ROOT/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
status=[]
for name in ['english','czech']:
    refs=json.loads((OUT/f'reference-{name}.json').read_text())
    for ref in refs:
        dest=OUT/(ref['id']+'-native.json')
        wav=ROOT/'.tw-cut-study'/('converted-'+ref['id']+'.wav')
        t=time.monotonic()
        try:
            subprocess.run([str(ROOT/'node_modules/ffmpeg-static/ffmpeg'),'-v','error','-y','-i',str(ROOT/ref['audio']),'-ac','1','-ar','16000',str(wav)],check=True,capture_output=True)
            p=subprocess.run([str(ROOT/'native/transcription'),str(wav),ref['locale']],capture_output=True,text=True,timeout=600)
            (OUT/(ref['id']+'-native.stderr')).write_text(p.stderr)
            if p.returncode==0:
                data=json.loads(p.stdout);dest.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
            status.append({'id':ref['id'],'exit':p.returncode,'seconds':time.monotonic()-t,'words':len(data['words']) if p.returncode==0 else 0})
            print(status[-1],flush=True)
        finally:
            wav.unlink(missing_ok=True)
        (OUT/'native-run-status.json').write_text(json.dumps(status,indent=2)+'\n')
(OUT/'native-build-sha256.txt').write_text(hashlib.sha256((ROOT/'native/transcription').read_bytes()).hexdigest()+'\n')
if any(s['exit'] for s in status): raise SystemExit(1)
