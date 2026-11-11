// This must be the first import of the app entry, before modules with startup side effects.
import { app } from 'electron'
import { writeSync } from 'node:fs'
import { forbiddenDebuggingSwitch } from './security-switches'

declare const __TW_SECURITY_TEST__: boolean
if (__TW_SECURITY_TEST__) {
  app.setName('TalkWeaver Security Test')
  // Packaging checks this literal so production output cannot masquerade as a test build.
  console.error('UNPUBLISHED_SECURITY_TEST_FLAVOUR')
} else if (app.isPackaged) {
  const denied = forbiddenDebuggingSwitch([...process.argv, ...process.execArgv])
    ?? ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'].find(name => app.commandLine.hasSwitch(name))
  if (denied) {
    writeSync(2, `TalkWeaver refuses debugging switches in production: ${denied}\n`)
    process.exit(1)
  }
}
