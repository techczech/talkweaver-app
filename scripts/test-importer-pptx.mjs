import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractPptx, inspectPptx, renderOriginalSlides, safeArchiveEntry } from '../src/main/importer/pptx.ts'

const root = mkdtempSync(join(tmpdir(), 'talkweaver-importer-pptx-'))
const packageDir = join(root, 'package')
const pptxPath = join(root, 'fixture.pptx')

function write(relativePath, contents, encoding = 'utf8') {
  const target = join(packageDir, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, encoding)
}

write('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="mp4" ContentType="video/mp4"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`)

write('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`)

write('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:extLst><p:ext><p14:sectionLst><p14:section><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>
</p:presentation>`)

write('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>`)

write('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="1000" cy="300"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Opening</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="100" y="600"/><a:ext cx="2000" cy="1200"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>First </a:t></a:r><a:r><a:rPr b="1"/><a:t>point </a:t></a:r><a:r><a:t>continues</a:t></a:r></a:p><a:p><a:r><a:t>Second point</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:pic>
      <p:nvPicPr><p:cNvPr id="4" name="Picture 3"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="3000" y="600"/><a:ext cx="1200" cy="900"/></a:xfrm></p:spPr>
    </p:pic>
    <p:pic>
      <p:nvPicPr><p:cNvPr id="5" name="Video 4"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rId5"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media r:embed="rId6"/></p:ext></p:extLst></p:nvPr></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="3300" y="800"/><a:ext cx="1200" cy="900"/></a:xfrm></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`)

write('ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/media1.mp4"/>
  <Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/media1.mp4"/>
</Relationships>`)

write('ppt/slides/slide2.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:sld show="0" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Hidden appendix</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`)

write('ppt/slides/_rels/slide2.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`)
write('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Sidebar title without text"><p:spTree/></p:cSld></p:sldLayout>`)
write('ppt/slides/slide3.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>AI Winter Cycle</a:t></a:r></a:p></p:txBody></p:sp>
    <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Timeline"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="100" y="600"/><a:ext cx="8000" cy="3000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="rId2" r:lo="rId3"/></a:graphicData></a:graphic></p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`)
write('ppt/slides/_rels/slide3.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="../diagrams/data1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout" Target="../diagrams/layout1.xml"/>
</Relationships>`)
write('ppt/diagrams/data1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<dgm:dataModel xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:ptLst>
  <dgm:pt modelId="root" type="doc"><dgm:t><a:txBody><a:p/></a:txBody></dgm:t></dgm:pt>
  <dgm:pt modelId="a"><dgm:t><a:txBody><a:p><a:r><a:t>1950s</a:t></a:r></a:p></a:txBody></dgm:t></dgm:pt>
  <dgm:pt modelId="b"><dgm:t><a:txBody><a:p><a:r><a:t>Setting out AI vision</a:t></a:r></a:p></a:txBody></dgm:t></dgm:pt>
  <dgm:pt modelId="c"><dgm:t><a:txBody><a:p><a:r><a:t>1960s</a:t></a:r></a:p></a:txBody></dgm:t></dgm:pt>
</dgm:ptLst><dgm:cxnLst>
  <dgm:cxn modelId="ca" srcId="root" destId="a" srcOrd="0" destOrd="0"/>
  <dgm:cxn modelId="cb" srcId="a" destId="b" srcOrd="0" destOrd="0"/>
  <dgm:cxn modelId="cc" srcId="root" destId="c" srcOrd="1" destOrd="0"/>
</dgm:cxnLst></dgm:dataModel>`)
write('ppt/diagrams/layout1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="urn:fixture:timeline"><dgm:title val="Horizontal Process"/><dgm:catLst><dgm:cat type="process"/><dgm:cat type="timeline"/></dgm:catLst></dgm:layoutDef>`)
write('ppt/notesSlides/notesSlide1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Speaker note for opening.</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`)

write('ppt/media/image1.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2VQAAAABJRU5ErkJggg==', 'base64'))
write('ppt/media/image2.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2VQAAAABJRU5ErkJggg==', 'base64'))
write('ppt/media/media1.mp4', Buffer.from('fixture video bytes'))

const zipped = spawnSync('zip', ['-qr', pptxPath, '.'], { cwd: packageDir, encoding: 'utf8' })
assert.equal(zipped.status, 0, zipped.stderr)

const inspected = await inspectPptx(pptxPath)
assert.equal(inspected.fileName, 'fixture.pptx')
assert.equal(inspected.slideCount, 3)
assert.equal(inspected.width, 12192000)
assert.equal(inspected.height, 6858000)
assert.match(inspected.hash, /^[a-f0-9]{64}$/)

const extracted = await extractPptx(pptxPath, join(root, 'out'))
assert.equal(extracted.slides.length, 3)
assert.equal(extracted.slides[0].title, 'Opening')
assert.deepEqual(extracted.slides[0].paragraphs, ['Opening', 'First point continues', 'Second point'])
assert.equal(extracted.slides[0].shapes.filter((shape) => shape.kind === 'picture').length, 1)
const video = extracted.slides[0].shapes.find((shape) => shape.kind === 'video')
assert.equal(video.mediaName, 'media1.mp4')
assert.equal(video.posterName, 'image2.png')
assert.notEqual(video.mediaPath, video.posterPath)
assert.deepEqual(extracted.slides[0].shapes.find((shape) => shape.kind === 'text' && shape.placeholder === 'body').markdownParagraphs, ['First **point** continues', 'Second point'])
assert.equal(extracted.slides[0].layoutName, 'Sidebar title without text')
assert.match(extracted.slides[0].notes, /Speaker note for opening/)
assert.equal(extracted.slides[1].hidden, true)
assert.equal(extracted.slides[1].title, 'Hidden appendix')
assert.equal(extracted.slides[2].title, 'AI Winter Cycle')
assert.deepEqual(extracted.slides[2].shapes.find((shape) => shape.kind === 'smartart'), {
  kind: 'smartart', id: '3', name: 'Timeline', layoutName: 'Horizontal Process', categories: ['process', 'timeline'],
  geometry: { x: 100, y: 600, width: 8000, height: 3000 }, zIndex: 3,
  nodes: [
    { id: 'a', text: '1950s', children: [{ id: 'b', text: 'Setting out AI vision', children: [] }] },
    { id: 'c', text: '1960s', children: [] }
  ]
})

assert.equal(safeArchiveEntry('ppt/slides/slide1.xml'), 'ppt/slides/slide1.xml')
for (const unsafe of ['../escape.xml', '/absolute.xml', 'ppt/../../escape.xml', 'bad\0name.xml']) {
  assert.throws(() => safeArchiveEntry(unsafe), /unsafe-pptx-entry/)
}

const renderRun = join(root, 'render-run')
const fakeTools = { officePath: '/fixture/bin/soffice', rasterPath: '/fixture/bin/pdftoppm' }
const fakeRunner = async (command, args) => {
  if (args.includes('--version')) return { code: 0, stdout: 'LibreOffice fixture 1.0\n', stderr: '' }
  if (args.length === 1 && args[0] === '-v') return { code: 0, stdout: '', stderr: 'pdftoppm fixture 2.0\n' }
  if (command === fakeTools.officePath) {
    const outDir = args[args.indexOf('--outdir') + 1]
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'fixture.pdf'), 'fixture pdf')
    return { code: 0, stdout: '', stderr: '' }
  }
  if (command === fakeTools.rasterPath) {
    const prefix = args.at(-1)
    writeFileSync(`${prefix}-1.png`, Buffer.from('slide one'))
    writeFileSync(`${prefix}-2.png`, Buffer.from('slide two'))
    return { code: 0, stdout: '', stderr: '' }
  }
  return { code: 127, stdout: '', stderr: `unexpected command: ${command}` }
}
const rendered = await renderOriginalSlides(pptxPath, renderRun, 3, fakeRunner, fakeTools)
assert.equal(rendered.renderer.officePath, fakeTools.officePath)
assert.equal(rendered.renderer.rasterPath, fakeTools.rasterPath)
assert.equal(rendered.renderer.officeVersion, 'LibreOffice fixture 1.0')
assert.equal(rendered.files.length, 2)

console.log('importer pptx: package facts, text, notes, media and archive safety passed')
