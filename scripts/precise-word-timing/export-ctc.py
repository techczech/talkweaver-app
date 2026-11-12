"""Reproducible LOCAL conversion; never uploads. Runtime ships no Python.
uv venv --python 3.12 scripts/precise-word-timing/local/export-venv
uv pip install --python scripts/precise-word-timing/local/export-venv/bin/python --exclude-newer '7 days' -r scripts/precise-word-timing/export-requirements.txt
.../bin/python scripts/precise-word-timing/export-ctc.py cs --source <pinned-snapshot-folder>
"""
import argparse,hashlib,json,pathlib,time,importlib.metadata,platform,sys
import os
os.environ['ORT_DISABLE_TELEMETRY']='1'
os.environ['HF_HUB_OFFLINE']='1'
import torch,onnx
from transformers import AutoModelForCTC
from onnxruntime.quantization import quantize_dynamic,QuantType
PINS={
 'en':('facebook/wav2vec2-base-960h','22aad52d435eb6dbaf354bdad9b0da84ce7d6156','8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a'),
 'cs':('comodoro/wav2vec2-xls-r-300m-cs-250','73e2b9004f35d3ca79316a624e7edc3cdaa45d40','99376277738caade67bf57b7dfab362b3172323b4724c0db4c51a56254340099')}
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
p=argparse.ArgumentParser();p.add_argument('language',choices=PINS);p.add_argument('--source',type=pathlib.Path,required=True);a=p.parse_args()
for package,version in [('torch','2.15.0'),('transformers','5.22.1'),('onnx','1.23.2'),('onnxruntime','1.31.1')]:
 if importlib.metadata.version(package)!=version:raise ValueError('Tool version mismatch: '+package)
model_id,revision,input_hash=PINS[a.language]
if sha(a.source/'model.safetensors')!=input_hash:raise ValueError('Source weights checksum mismatch')
inputs=json.loads((pathlib.Path(__file__).with_name('export-input-pins.json')).read_text())[a.language]
for name,pin in inputs['files'].items():
 data=(a.source/name).read_bytes()
 if pin.get('sha256'):
  if hashlib.sha256(data).hexdigest()!=pin['sha256']:raise ValueError('Source checksum mismatch: '+name)
 elif hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()!=pin['gitBlob']:raise ValueError('Source git blob mismatch: '+name)
out=pathlib.Path(__file__).resolve().parent/'local'/a.language;out.mkdir(parents=True,exist_ok=True)
torch.set_num_threads(2);torch.manual_seed(0)
model=AutoModelForCTC.from_pretrained(a.source,local_files_only=True,use_safetensors=True,attn_implementation='eager').eval()
class Acoustic(torch.nn.Module):
 def __init__(self,m):super().__init__();self.m=m
 def forward(self,input_values):return self.m(input_values,return_dict=False)[0]
start=time.monotonic();fp=out/'model-fp32.onnx';q=out/'model-int8.onnx'
with torch.inference_mode():
 torch.onnx.export(Acoustic(model),torch.zeros(1,16000),str(fp),input_names=['input_values'],output_names=['logits'],dynamic_axes={'input_values':{1:'samples'},'logits':{1:'frames'}},opset_version=17,dynamo=False,external_data=False)
onnx.checker.check_model(str(fp))
quantize_dynamic(str(fp),str(q),weight_type=QuantType.QInt8,per_channel=True,op_types_to_quantize=['MatMul'])
onnx.checker.check_model(str(q))
for name in ['vocab.json','config.json','preprocessor_config.json']:(out/name).write_bytes((a.source/name).read_bytes())
record={'model':model_id,'revision':revision,'licence':'Apache-2.0','sourceSHA256':input_hash,'inputPins':inputs,'platform':platform.platform(),'machine':platform.machine(),'python':sys.version,'converterSHA256':sha(__file__),'tools':{n:importlib.metadata.version(n) for n in ['torch','transformers','onnx','onnxruntime']},'opset':17,'quantisation':'dynamic signed int8 MatMul weights, per channel; convolution remains fp32','seconds':time.monotonic()-start,'outputs':[{'file':f.name,'bytes':f.stat().st_size,'sha256':sha(f)} for f in [fp,q]]}
(out/'conversion.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record),flush=True)
