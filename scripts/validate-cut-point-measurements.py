"""Independent Python reconciliation of Node metric rows, counts and quantiles."""
import json,math,pathlib
p=pathlib.Path(__file__).resolve().parent.parent/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
r=json.loads((p/'measurement-summary.json').read_text())
rows=[json.loads(line) for line in (p/'measurement-rows.jsonl').read_text().splitlines()]
checks=0
for name,s in r['sets'].items():
    rr=[x for x in rows if name=='all' or x['set']==name]
    for kind in ['returned','trimmed','snapped']:
        words=[x for x in rr if x['type']=='word' and x['kind']==kind]
        assert len(words)==s['matchedWords'];checks+=1
        for edge in ['start','end']:
            a=sorted(abs(w[edge]) for w in words)
            for label,q in [('median',.5),('p90',.9),('p95',.95),('max',1)]:
                expected=a[max(0,math.ceil(q*len(a))-1)] if a else None
                assert s['errors'][kind][edge][label]==expected;checks+=1
        for split in ['all','pause','continuous']:
            b=[x for x in rr if x['type']=='boundary' and x['kind']==kind and (split=='all' or x['pause']==(split=='pause'))]
            v=s['clipping'][kind][split]
            assert len(b)==v['n'];checks+=1
            for threshold in [30,80]:
                # Recompute directly from directional signed edge deltas, not the saved clip field.
                n=sum(max(0,x['referenceLeftEnd']-x['cutStart'],x['cutEnd']-x['referenceRightStart'])>threshold+1e-6 for x in b)
                assert n==v['over'+str(threshold)];checks+=1
                if b: assert abs(n/len(b)*100-v['over'+str(threshold)+'Percent'])<1e-10;checks+=1
        assert s['clipping'][kind]['pause']['n']+s['clipping'][kind]['continuous']['n']==s['boundaries'];checks+=1
    v=s['sentences'];assert v['found']+v['false']==v['predicted'];checks+=1
allset=r['sets']['all']
assert allset['durationSeconds']>=300 and allset['speakers']>=4 and allset['boundaries']>=300;checks+=1
for key in ['matchedWords','referenceWords','returnedWords','boundaries','clips']:
    assert allset[key]==sum(r['sets'][name][key] for name in ['librispeech-en','parlaspeech-cs']);checks+=1
result={'checks':checks,'result':'PASS','method':'independent Python quantile/count reconciliation; clipping recomputed from deletion endpoints','scope':'arithmetic consistency, not validation of aligner phonetic ground truth'}
(p/'measurement-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
