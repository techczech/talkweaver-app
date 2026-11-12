"""One suite per shared slot; retain exact logs and exit codes."""
import json, pathlib, subprocess, sys, tempfile, os
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'evidence/alpha-0440-1'
commands=[('unit',['npm','run','test:unit']),('presenter-layers',['node','e2e/diagnose-presenter-layers.mjs']),('saved-words',['node','e2e/diagnose-saved-words.mjs']),('alignment-ui',['node','e2e/diagnose-precise-word-timing.mjs'])]
journeys_only='--journeys-only' in sys.argv
if journeys_only: commands=[row for row in commands if row[0]!='unit']
results=json.loads((out/'sanity-results.json').read_text()) if journeys_only else []
for name,cmd in commands:
 with (out/(name+'.log')).open('w') as log:
  with tempfile.TemporaryDirectory(prefix='.alpha-sanity-',dir=root) as scratch:
   p=subprocess.run([str(pathlib.Path.home()/'.local/bin/agent-run'),'--wait','5400','--',*cmd],cwd=root,stdout=log,stderr=subprocess.STDOUT,env={**os.environ,'TMPDIR':scratch+'/'} )
 results.append(dict(name=name,command=cmd,exit=p.returncode))
 (out/'sanity-results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(name,p.returncode,flush=True)
 if p.returncode==75: break

raise SystemExit(next((r['exit'] for r in results if r['exit']),0))
