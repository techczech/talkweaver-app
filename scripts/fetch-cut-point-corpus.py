"""Fetch public speech only; raw archives/audio stay in ignored .tw-cut-study.
Reference/ASR derivatives go in the existing slice-2 acceptance folder.
No installed packages; Python standard library + repository ffmpeg.
"""
import argparse, hashlib, io, json, pathlib, re, shutil, tarfile, urllib.request, zipfile
ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / '.tw-cut-study'
OUT = ROOT / 'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
CACHE.mkdir(exist_ok=True); OUT.mkdir(exist_ok=True)
def fetch(url, path):
    if path.exists(): return
    with urllib.request.urlopen(url, timeout=120) as src, path.open('wb') as dest: shutil.copyfileobj(src, dest)
def sha(path):
    with path.open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()
def save(name, obj): (OUT/name).write_text(json.dumps(obj, ensure_ascii=False, indent=2)+'\n')
def english():
    fetch('https://zenodo.org/records/2619474/files/librispeech_alignments.zip?download=1', CACHE/'alignments.zip')
    fetch('https://www.openslr.org/resources/12/dev-clean.tar.gz', CACHE/'dev-clean.tar.gz')
    fetch('https://www.openslr.org/resources/145/manifests.tar.gz', CACHE/'pc-manifests.tar.gz')
    z=zipfile.ZipFile(CACHE/'alignments.zip')
    names=[n for n in z.namelist() if '/dev-clean/' in n and n.endswith('.TextGrid')]
    if not names: names=[n for n in z.namelist() if 'dev-clean' in n and n.endswith('.TextGrid')]
    speakers=sorted({n.split('/')[-1].split('-')[0] for n in names},key=int)[:4]
    print('Preselected English speakers:',speakers,flush=True)
    selected=[]
    with (CACHE/'alignments.zip').open('rb') as f:
        if hashlib.file_digest(f, 'md5').hexdigest() != '2bab567d0ace651a4ba254e813629f46': raise ValueError('Zenodo archive checksum mismatch')
    for speaker in speakers:
        duration=0
        for n in sorted(n for n in names if n.split('/')[-1].split('-')[0]==speaker):
            text=z.read(n).decode()
            # Praat long TextGrid: use only the word tier, never phone boundaries.
            tiers=re.split(r'item \[\d+\]:',text)
            wordtier=next(t for t in tiers if re.search(r'name = "words"',t))
            words=[]
            for a,b,w in re.findall(r'intervals \[\d+\]:\s*xmin = ([\d.]+)\s*xmax = ([\d.]+)\s*text = "([^"]*)"',wordtier):
                if w.strip(): words.append({'text':w,'start':float(a)*1000,'end':float(b)*1000})
            total=float(re.search(r'xmax = ([\d.]+)',text)[1])
            selected.append({'id':pathlib.Path(n).stem,'set':'librispeech-en','speaker':speaker,'locale':'en-US','durationMs':total*1000,'reference':words,'alignmentMember':n,'alignmentSha256':hashlib.sha256(z.read(n)).hexdigest()})
            duration+=total
            if duration>=90: break
    ids={s['id']:s for s in selected}
    with tarfile.open(CACHE/'dev-clean.tar.gz') as t:
        for m in t:
            stem=pathlib.Path(m.name).stem
            if stem in ids and m.name.endswith('.flac'):
                target=CACHE/(stem+'.flac');target.write_bytes(t.extractfile(m).read());ids[stem]['audio']=str(target.relative_to(ROOT));ids[stem]['audioSha256']=sha(target)
    with tarfile.open(CACHE/'pc-manifests.tar.gz') as t:
        for m in t:
            if m.isfile() and ('dev' in m.name):
                raw=t.extractfile(m).read().decode()
                for line in raw.splitlines():
                    try: row=json.loads(line)
                    except ValueError: continue
                    stem=pathlib.Path(row.get('audio_filepath','')).stem
                    if stem in ids: ids[stem]['punctuatedReference']=row.get('text');ids[stem]['punctuationMember']=m.name
    for s in selected:
        if 'audio' not in s: raise ValueError('Audio missing: '+s['id'])
    save('reference-english.json',selected)
    save('archive-hashes.json',{p.name:sha(p) for p in [CACHE/'alignments.zip',CACHE/'dev-clean.tar.gz',CACHE/'pc-manifests.tar.gz']})
    print('English',len(selected),sum(s['durationMs'] for s in selected)/1000,'seconds',flush=True)
def czech():
    url='https://datasets-server.huggingface.co/first-rows?dataset=classla/ParlaSpeech-CZ&config=default&split=train'
    # Public dataset media URLs expire; refresh the public response if needed.
    with urllib.request.urlopen(url,timeout=120) as r: data=json.load(r)
    expected='e85fdee6ab9d364749102d60be21d0196d2420dd'
    actual=data.get('dataset_git_revision', expected)
    if actual != expected: raise ValueError('Czech source revision changed; review provenance before a new study')
    selected=[]
    for entry in data['rows']:
        row=entry['row']
        if len(row['words'])<8 or row['audio_length']<4: continue
        idx=entry['row_idx']; path=CACHE/f'czech-{idx}.wav'
        if f'/--/{expected}/--/' not in row['audio'][0]['src']: raise ValueError('Czech media revision changed; review source snapshot')
        fetch(row['audio'][0]['src'],path)
        words=[{'text':row['text'][w['char_s']:w['char_e']],'start':w['time_s']*1000,'end':w['time_e']*1000} for w in row['words']]
        selected.append({'id':f'czech-{idx}','sourceId':row['id'],'row':idx,'set':'parlaspeech-cs','speaker':row['Speaker_ID'],'locale':'cs-CZ','durationMs':row['audio_length']*1000,'audio':str(path.relative_to(ROOT)),'audioSha256':sha(path),'reference':words,'punctuatedReference':row['text'],'sourceRevision':'e85fdee6ab9d364749102d60be21d0196d2420dd','originalAudioSource':row['audio_source'],'originalStart':row['audio_start']})
    save('reference-czech.json',selected)
    print('Czech',len(selected),sum(s['durationMs'] for s in selected)/1000,'seconds',flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('set',choices=['english','czech']);args=p.parse_args()
    (english if args.set=='english' else czech)()
