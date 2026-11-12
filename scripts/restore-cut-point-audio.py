"""Restore only audio for the frozen references; do not regenerate reference labels."""
import hashlib,json,pathlib,tarfile,urllib.request,shutil
root=pathlib.Path(__file__).resolve().parent.parent
cache=root/'.tw-cut-study';cache.mkdir(exist_ok=True)
out=root/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
refs=json.loads((out/'reference-english.json').read_text());ids={r['id']:r for r in refs}
archive=cache/'dev-clean.tar.gz'
if not archive.exists():
    with urllib.request.urlopen('https://www.openslr.org/resources/12/dev-clean.tar.gz',timeout=120) as src,archive.open('wb') as dst: shutil.copyfileobj(src,dst)
with tarfile.open(archive) as tar:
    for member in tar:
        name=pathlib.Path(member.name)
        if name.stem in ids and name.suffix=='.flac':
            data=tar.extractfile(member).read();ref=ids[name.stem]
            assert hashlib.sha256(data).hexdigest()==ref['audioSha256']
            (root/ref['audio']).write_bytes(data)
print('Frozen English audio restored and hashes verified')
