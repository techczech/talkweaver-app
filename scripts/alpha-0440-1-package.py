"""Build/stage only; each heavy operation takes a separate shared slot."""
import pathlib,subprocess,tempfile,os
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'evidence/alpha-0440-1'
app=root/'release/mac-arm64/TalkWeaver.app'
def run(name,cmd,slot=True,env=None,required=True):
 with (out/(name+'.log')).open('w') as log:
  with tempfile.TemporaryDirectory(prefix='.alpha-package-',dir=root) as scratch:
   p=subprocess.run(([str(pathlib.Path.home()/'.local/bin/agent-run'),'--wait','5400','--'] if slot else [])+cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT,env={**(env or os.environ),'TMPDIR':scratch+'/'} )
 print(name,p.returncode,flush=True)
 if p.returncode==75: raise SystemExit(75)
 if p.returncode and required: raise SystemExit(p.returncode)
run('native',['npm','run','build:native'])
run('package',['node_modules/.bin/electron-builder','--config','build/electron-builder.alpha.cjs','--mac','--arm64','--dir','--publish','never'])
run('package-verifier',['node','scripts/verify-mac-package.mjs','--require-signed',str(app)],False)
run('electron-security',['node','scripts/verify-electron-security.cjs',str(app)],False)
run('production-startup',['node','scripts/smoke-security-production.mjs',str(app)])
run('receipt',['node','scripts/alpha-0440-1-receipt.cjs'],False)
run('hidden-launch',['python3','scripts/alpha-0440-1-hidden-launch.py'])
run('signed-speech',['python3','scripts/alpha-0440-1-signed-speech.py'],required=False)
run('alignment-package-content',['node','scripts/precise-word-timing/verify-package-content.mjs',str(app)],False)
run('packaged-alignment',['node','scripts/alpha-0440-1-packaged-alignment.mjs'],required=False)
run('signature',['codesign','-dvvv',str(app)],False)
run('archive',['ditto','-c','-k','--sequesterRsrc','--keepParent',str(app),str(root/'release/alpha-0440-1-air.zip')])
run('archive-verifier',['node','scripts/verify-mac-package.mjs','--require-signed',str(root/'release/alpha-0440-1-air.zip')])
