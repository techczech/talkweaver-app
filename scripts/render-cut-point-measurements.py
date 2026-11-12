"""Render measured values only; interpretation stays in acceptance.md."""
import json,pathlib
p=pathlib.Path(__file__).resolve().parent.parent/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
r=json.loads((p/'measurement-summary.json').read_text())
def f(x): return 'n/a' if x is None else f'{x:.1f}'
lines=['---','title: Continuous speech cut-point measurement tables','register: FOR AGENTS','created: 2026-11-10','source: measurement-summary.json','---','','Absolute errors in milliseconds; nearest-rank quantiles. Rates are reference-inferred clipping, conditional on adjacent correct recognition. See [sources and method](corpus-sources-and-method.md).','','| Set | Clips | Speakers | Seconds | Reference words | Returned words | Matched words | Eligible boundaries |','|---|---:|---:|---:|---:|---:|---:|---:|']
for name,s in r['sets'].items():
 lines.append(f"| {name} | {s['clips']} | {s['speakers']} | {f(s['durationSeconds'])} | {s['referenceWords']} | {s['returnedWords']} | {s['matchedWords']} | {s['boundaries']} |")
lines+=['','| Set | Times | Edge | n | Median | p90 | p95 | Max |','|---|---|---|---:|---:|---:|---:|---:|']
for name,s in r['sets'].items():
 for kind,edges in s['errors'].items():
  for edge,v in edges.items():lines.append(f"| {name} | {kind} | {edge} | {v['n']} | {f(v['median'])} | {f(v['p90'])} | {f(v['p95'])} | {f(v['max'])} |")
lines+=['','| Set | Times | Boundary split | n | >30 ms | >80 ms |','|---|---|---|---:|---:|---:|']
for name,s in r['sets'].items():
 for kind,splits in s['clipping'].items():
  for split,v in splits.items():lines.append(f"| {name} | {kind} | {split} | {v['n']} | {v['over30']}/{v['n']} ({f(v['over30Percent'])}%) | {v['over80']}/{v['n']} ({f(v['over80Percent'])}%) |")
lines+=['','Start/end errors at the eligible boundaries, split by the operational pause signal (start = retained right word; end = retained left word).','','| Set | Times | Split | Edge | n | Median | p90 | p95 | Max |','|---|---|---|---|---:|---:|---:|---:|---:|']
for name,s in r['sets'].items():
 for kind,splits in s['boundaryErrors'].items():
  for split,edges in splits.items():
   if split=='all':continue
   for edge,v in edges.items():lines.append(f"| {name} | {kind} | {split} | {edge} | {v['n']} | {f(v['median'])} | {f(v['p90'])} | {f(v['p95'])} | {f(v['max'])} |")
lines+=['','| Set | Clips with punctuation reference | Reference ends | Found | Recall | Predicted | False | False share | Untimed reference ends | Unscored predictions |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
for name,s in r['sets'].items():
 v=s['sentences'];lines.append(f"| {name} | {v['clipsWithReference']} | {v['reference']} | {v['found']} | {f(v['recallPercent'])}% | {v['predicted']} | {v['false']} | {f(v['falseDiscoveryPercent'])}% | {v['unscorableReference']} | {v['unscoredPredictions']} |")
(p/'cut-point-measurement-tables.md').write_text('\n'.join(lines)+'\n')
