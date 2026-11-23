"""Font coverage uses the CI dependency pin in scripts/font-test-requirements.txt."""
from importlib.util import find_spec
from pathlib import Path
import os

if find_spec('fontTools') is None:
    print('TEST NOT RUN: fontTools not installed. Install from scripts/font-test-requirements.txt.')
    raise SystemExit(77)

from fontTools.ttLib import TTFont
letters = set('ÁáÄäČčĎďÉéĚěÍíĹĺĽľŇňÓóÔôÖöŔŕŘřŠšŤťÚúŮůÜüÝýŽžĄąĆćĘęŁłŃńŚśŹźŻżŐőŰűßẞÀàÂâÆæÇçÈèÊêËëÎîÏïŒœÙùÛûŸÿÑñ¡¿')
fonts = Path(os.environ.get('TW_FONT_TEST_ROOT', Path(__file__).resolve().parents[1] / 'compiler/assets/fonts'))
for family, weights in [('inter', ['300','400','600','700']), ('geist',['wght']), ('fraunces',['600']), ('alegreya-sans',['400','700'])]:
    for weight in weights:
        cmap=set()
        for subset in ['latin','latin-ext']:
            font=TTFont(fonts/f'{family}-{subset}-{weight}-normal.woff2')
            cmap.update(font.getBestCmap())
            if weight != 'wght':
                assert font['OS/2'].usWeightClass == int(weight), (family, weight, subset, 'wrong weight')
            if 'fvar' in font:
                axis=next(a for a in font['fvar'].axes if a.axisTag=='wght')
                assert axis.minValue<=300 and axis.maxValue>=700
        missing=[c for c in letters if ord(c) not in cmap]
        assert not missing, (family,weight,missing)
        print(f'{family} {weight}: {len(letters)} required letters covered')

# The browser picks a file by the CSS unicode-range, not by the union of both files: every required
# letter must be present in at least one file whose declared range includes it.
import re
css = (Path(__file__).resolve().parents[1] / 'compiler/assets/styles/skin/zz-x-ocean-05-type.css').read_text()
routes = {}
for family, file, rng in re.findall(r"@font-face \{[^}]*font-family: '([^']+)'[^}]*url\('\.\./\.\./fonts/([^']+)'\)[^}]*unicode-range: ([^;]+);", css):
    spans = [(int(a, 16), int(b or a, 16)) for a, _, b in (part.strip()[2:].partition('-') for part in rng.split(','))]
    weight = re.search(r'-(\d+|wght)-normal', file).group(1)
    routes.setdefault((family, weight), []).append((set(TTFont(fonts / file).getBestCmap()), spans))
assert len(routes) == 8, routes.keys()
for key, faces in routes.items():
    unrouted = [c for c in letters if not any(ord(c) in cmap and any(a <= ord(c) <= b for a, b in spans) for cmap, spans in faces)]
    assert not unrouted, (key, 'letters whose declared file lacks the glyph', unrouted)
print('unicode-range routing: every required letter reaches a file that holds it')
