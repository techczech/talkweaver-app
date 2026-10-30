// The process an Insert › HTML page… copy runs in: started per import as an Electron utility process
// whose working directory is the talk folder (prepare-talk-utility-process.ts, forkHtmlPageImportChild).
// That held folder is the write authority (html-page-import-core.ts says why), and the read, the
// names scan and the copy of a page up to 20 MB happen here, never on Electron main.
//
// The job arrives as the one message on process.parentPort; the process answers once with the
// import's answer, and main ends it (html-page-import.ts, createHtmlPageImportRunner).
//
// No Electron import and erasable TypeScript only: the plain-Node tests start this file with a
// stand-in for process.parentPort (scripts/lib/node-compile-child.mjs).
import { HTML_PAGE_TEXT, importInWorkingFolder, refusal, type HtmlPageImportJob } from './html-page-import-core.ts'

const port = process.parentPort
port.once('message', (event: { data: HtmlPageImportJob }) => {
  let answer
  try {
    answer = importInWorkingFolder(event.data)
  } catch (error) {
    console.error('[html-page-import]', error)
    answer = refusal('write-failed', HTML_PAGE_TEXT.writeFailed)
  }
  port.postMessage(answer)
})
