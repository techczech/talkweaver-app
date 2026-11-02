// The process a saved view of a live web page is written in: started per capture as an Electron
// utility process whose working directory is the talk folder (prepare-talk-utility-process.ts,
// forkLivePageCaptureChild). That held folder is the write authority (live-page-capture-core.ts).
//
// The job arrives as the one message on process.parentPort; the process answers once and main ends it
// (live-page-capture.ts, createLivePageCaptureRunner).
//
// No Electron import and erasable TypeScript only: the plain-Node tests start this file with a
// stand-in for process.parentPort.
import { captureRefusal, writeCaptureInWorkingFolder, type CaptureJob } from './live-page-capture-core.ts'

const port = process.parentPort
port.once('message', (event: { data: CaptureJob }) => {
  let answer
  try {
    answer = writeCaptureInWorkingFolder(event.data)
  } catch (error) {
    console.error('[live-page-capture]', error)
    answer = captureRefusal('write-failed')
  }
  port.postMessage(answer)
})
