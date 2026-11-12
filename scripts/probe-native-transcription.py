"""Public/synthetic inputs only. Run inside agent-run. Keeps JSON evidence; removes audio."""
import urllib.parse
import json, pathlib, subprocess, tempfile, wave, math, struct, time, hashlib, urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'docs/design/2026-11-10-record-and-edit-video/built/slice-2'
helper=root/'native/transcription'
results={}
def run(name,path,locale='en-US',timeout=1200):
    start=time.monotonic()
    try:
        p=subprocess.run([str(helper),str(path),locale],capture_output=True,text=True,timeout=timeout)
        (out/(name+'.stderr')).write_text(p.stderr)
        value=json.loads(p.stdout) if p.returncode==0 else {'error':p.stderr[-1000:]}
        (out/(name+'.json')).write_text(json.dumps(value,ensure_ascii=False,indent=2))
        results[name]={'exit':p.returncode,'seconds':time.monotonic()-start,'words':len(value.get('words',[])),'text':' '.join(w['text'] for w in value.get('words',[]))[:500]}
    except Exception as e: results[name]={'error':str(e),'seconds':time.monotonic()-start}
with tempfile.TemporaryDirectory(prefix='.tw-native-probe-',dir=root) as td:
    td=pathlib.Path(td)
    def wav(name,seconds,tone=False):
        path=td/name
        with wave.open(str(path),'wb') as f:
            f.setparams((1,2,16000,0,'NONE','not compressed'))
            block=b''.join(struct.pack('<h',int(10000*math.sin(i*2*math.pi*220/16000))) for i in range(16000)) if tone else bytes(32000)
            for _ in range(seconds): f.writeframesraw(block)
        return path
    short=wav('silence.wav',3);run('silence',short)
    long=wav('hour.wav',3600);run('sixty-minute-silence',long,timeout=1800)
    p=subprocess.Popen([str(helper),str(long),'en-US'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    time.sleep(.25);start=time.monotonic();p.terminate();p.communicate(timeout=5)
    results['cancel']={'latencyMs':(time.monotonic()-start)*1000,'exit':p.returncode}
    for name,voice,text,locale in [('english','Samantha','Welcome to this presentation. These words stay on this Mac.','en-US'),('czech','Zuzana','Dobrý den. Toto je zkouška českého přepisu.','cs-CZ'),('mixed','Zuzana','Dobrý den. Welcome to this presentation. Děkuji za pozornost.','cs-CZ')]:
        path=td/(name+'.aiff')
        p=subprocess.run(['/usr/bin/say','-v',voice,'-o',str(path),text],capture_output=True,text=True)
        if p.returncode:results[name]={'error':p.stderr}
        else:
            run(name,path,locale)
            if name=='english':
                repeated=td/'hour-speech.wav'
                ffmpeg=root/'node_modules/ffmpeg-static/ffmpeg'
                converted=subprocess.run([str(ffmpeg),'-v','error','-y','-stream_loop','-1','-i',str(path),'-t','3600','-ac','1','-ar','16000',str(repeated)],capture_output=True,text=True)
                if converted.returncode:results['sixty-minute-speech']={'error':converted.stderr}
                else:run('sixty-minute-speech',repeated,timeout=1800)
    # Independent English public speech probe; Czech asset failure must not erase human timing evidence.
    filename='En-us-hello.ogg';md5=hashlib.md5(filename.encode()).hexdigest()
    english_url='https://upload.wikimedia.org/wikipedia/commons/'+md5[0]+'/'+md5[:2]+'/'+filename
    try:
        request=urllib.request.Request(english_url,headers={'User-Agent':'TalkWeaverAcceptance/1.0'})
        public=out/'fixtures';public.mkdir(exist_ok=True)
        original=public/'human-english.ogg';original.write_bytes(urllib.request.urlopen(request,timeout=45).read())
        padded=public/'human-english.wav'
        converted=subprocess.run([str(root/'node_modules/ffmpeg-static/ffmpeg'),'-v','error','-y','-i',str(original),'-af','adelay=500:all=1,apad=pad_dur=0.5','-ac','1','-ar','16000',str(padded)],capture_output=True,text=True)
        if converted.returncode:raise RuntimeError(converted.stderr)
        run('human-english',padded)
        results['human-english-source']={'url':english_url,'licence':'PD-self','speaker':'Dvortygirl','expected':'hello','paddingMs':500}
    except Exception as e:results['human-english']={'error':str(e)}
    # CC0 public human speech: Ghost4Man, Lingua Libre. Download original, no private inputs.
    filename='LL-Q9056 (ces)-Ghost4Man-návštěvník.wav'
    md5=hashlib.md5(filename.replace(' ','_').encode()).hexdigest()
    url='https://upload.wikimedia.org/wikipedia/commons/'+md5[0]+'/'+md5[:2]+'/'+urllib.parse.quote(filename.replace(' ','_'))
    try:
        request=urllib.request.Request(url,headers={'User-Agent':'TalkWeaverAcceptance/1.0 (local transcription test)'})
        path=td/'human.wav';path.write_bytes(urllib.request.urlopen(request,timeout=45).read())
        public=out/'fixtures';public.mkdir(exist_ok=True);(public/'human-czech.wav').write_bytes(path.read_bytes())
        run('human-czech',path,'cs-CZ')
        results['human-source']={'url':url,'licence':'CC0','speaker':'Ghost4Man','expected':'návštěvník','handCheckedBoundaries':False}
    except Exception as e:results['human-czech']={'error':str(e)}
(out/'probe-summary.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False,indent=2))
