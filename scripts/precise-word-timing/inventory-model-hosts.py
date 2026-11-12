"""Public API metadata only; never reads credentials, never uploads model files."""
import json,urllib.request,pathlib,datetime
repos=['facebook/wav2vec2-base-960h','Xenova/wav2vec2-base-960h','comodoro/wav2vec2-xls-r-300m-cs-250']
rows=[]
for repo in repos:
    url='https://huggingface.co/api/models/'+repo+'?blobs=true'
    data=json.load(urllib.request.urlopen(url,timeout=30))
    rows.append({'repository':repo,'api':url,'revision':data['sha'],'licence':data.get('cardData',{}).get('license'),'files':[{'name':f['rfilename'],'bytes':f.get('size'),'sha256':f.get('lfs',{}).get('sha256')} for f in data['siblings']]})
path=pathlib.Path('docs/design/2026-11-10-record-and-edit-video/built/slice-2b/model-host-inventory.json')
path.write_text(json.dumps({'retrieved':datetime.datetime.now(datetime.timezone.utc).isoformat(),'models':rows},indent=2)+'\n')
