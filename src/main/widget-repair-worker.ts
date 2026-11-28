// A repair offer may walk the vault and hash several candidate widget graphs.
import { readWidgetRepairOffers } from './widget-repair.ts'

const port = process.parentPort
port?.once('message', ({ data }: { data: { vault: string; outlinePath: string; refs: string[] } }) => {
  try { port.postMessage(readWidgetRepairOffers(data.vault, data.outlinePath, data.refs)) }
  catch { port.postMessage(new Map()) }
})
