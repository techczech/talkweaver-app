"""Build-time measurement only. Downloads public pinned data; never uploads."""
import hashlib,pathlib,urllib.request,json,sys
root=pathlib.Path(__file__).resolve().parent/'local'
root.mkdir(exist_ok=True)
revision='a19f851b3d42865797e410752b4c570c871e4825'
base=f'https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/{revision}/'
model=('onnx/model.onnx','e46614273f03ff4b87923a965e417fa72004825522cb007c9c25633b8475490d') if '--fp32' in sys.argv else ('onnx/model_int8.onnx','a4249bb7b7bcbe391be19980922b0523c0907e976a9e5d5aabfadb40fcea5058')
for name,sha in [model,('vocab.json','4178db26b3c7570f6a47f14ac6a1c7b32950b8c2800fb097287e53776934f1c5'),('config.json','ceff8f92e6670ad3633779bd43b3559628c1a64b0868ef6046b23d62b85c69d5'),('preprocessor_config.json','8cdfd65ff4115423185a1512bdae100e2e0cd744f5b322417429944aaafd0827')]:
    target=root/pathlib.Path(name).name
    if not target.exists(): urllib.request.urlretrieve(base+name,target)
    actual=hashlib.sha256(target.read_bytes()).hexdigest()
    if sha and actual!=sha: raise ValueError('Checksum mismatch')
    print(json.dumps({'file':target.name,'url':base+name,'bytes':target.stat().st_size,'sha256':actual}))
