"""Bounded RMS-ratio calibration against the frozen corpus. Run through agent-run.
This is training-corpus evidence, not an independent accuracy claim.
"""
import array,json,math,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
records=[]
for language in ['english','czech']:
    for ref in json.loads((out/f'reference-{language}.json').read_text()):
        p=subprocess.run([str(root/'node_modules/ffmpeg-static/ffmpeg'),'-v','error','-i',str(root/ref['audio']),'-ac','1','-ar','16000','-f','f32le','-'],check=True,capture_output=True)
        samples=array.array('f',p.stdout)
        levels=[math.sqrt(sum(x*x for x in samples[i:i+160])/len(samples[i:i+160])) for i in range(0,len(samples),160)]
        durations=[min(160,len(samples)-i)/16 for i in range(0,len(samples),160)]
        ordered=sorted(levels);noise=ordered[int((len(ordered)-1)*.1)];speech=ordered[int((len(ordered)-1)*.9)]
        records.append((ref,levels,durations,noise,speech))
print('p90 RMS ranges:',min(r[4] for r in records),max(r[4] for r in records),flush=True)
results=[]
for ratio in [.15,.2,.3,.5]:
    for ref,levels,durations,noise,speech in records:
        start=max(noise*2,speech*ratio);end=start/2
        silence=[];quiet=0;time=0;speaking=False
        for rms,duration in zip(levels,durations):
            nxt=rms>0 and rms >= (end if speaking else start)
            if nxt and not speaking:
                if quiet is not None and time>quiet:silence.append({'start':quiet,'end':time})
                quiet=None
            if not nxt and speaking:quiet=time
            speaking=nxt;time+=duration
        if quiet is not None and time>quiet:silence.append({'start':quiet,'end':time})
        raw=json.loads((out/(ref['id']+'-native.json')).read_text());raw['silence']=silence
        (out/(ref['id']+'-relative.json')).write_text(json.dumps(raw,ensure_ascii=False,indent=2)+'\n')
    subprocess.run(['node','scripts/measure-cut-point-corpus.mjs','baseline','--relative'],cwd=root,check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['node','scripts/compare-relative-measurement.mjs'],cwd=root,stdout=subprocess.DEVNULL)
    comparison=json.loads((out/'relative-comparison.json').read_text())
    row={'ratio':ratio,**comparison};results.append(row)
    print(ratio,len(comparison['regressions']),flush=True)
(out/'relative-calibration.json').write_text(json.dumps(results,indent=2)+'\n')
