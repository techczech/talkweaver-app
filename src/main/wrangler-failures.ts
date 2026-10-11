// Sorting a failed wrangler run by what it printed.
//
// One failure is recognised here. wrangler compiles the Worker with esbuild, and esbuild reads
// `tsconfig.json`, `jsconfig.json` and `package.json` in every parent folder of the Worker's files
// and of the folder wrangler runs in. A malformed one makes `dev` (the local live service: tests and
// the unpackaged app) fail with esbuild's JSON error, which names the file. That is turned into a
// message a person can act on. (The live service's set-up compiles nothing and cannot meet this:
// ticket 11.)
// TalkWeaver itself never opens those files: the path comes from what esbuild printed.
//
// The shape, as wrangler 4.144 with esbuild 0.28.1 prints it:
//
//   ✘ [ERROR] Build failed with 1 error:
//
//     ✘ [ERROR] Expected string in JSON but found "this"
//
//         ../../../../tsconfig.json:1:23:
//           1 │ { "compilerOptions": { this is not JSON
//
// The path is relative to the folder wrangler ran in (absolute when it is on another drive). The
// error texts seen: `Expected string in JSON but found …`, `Unexpected end of file in JSON`,
// `JSON does not support comments`, `JSON does not support trailing commas`,
// `JSON strings must use double quotes`, `Expected end of file in JSON but found …`,
// `Unexpected "NaN" in JSON`. Anything else is not recognised and stays the general failure.
//
// Colour. The launcher asks for none (NO_COLOR, FORCE_COLOR=0), but wrangler formats these esbuild
// blocks with colour regardless, so the `[ERROR]` line and the source excerpt carry colour codes.
// The place line does not: esbuild prints the path there exactly, byte for byte. So:
//   - only the `[ERROR]` line has colour codes removed, and only to recognise it;
//   - the place line is read as printed. An escape byte inside it is part of the path (a folder can
//     be named that way) and is kept, so the path names the real file;
//   - a place line that BEGINS with an escape byte is not what esbuild prints for a path (it prints
//     `../…`, `/…` or a drive letter): that would be colouring this code does not know, and the
//     answer is null rather than a guess.
// When the path is shown to a person, control characters are written out (`\x1b`), so a path cannot
// move the cursor, change colours or hide text in whatever displays it.
//
// Pure. No Electron import, erasable TypeScript only.
import { posix, win32 } from 'node:path'

export const BLOCKING_FILE_MESSAGE = 'A file on this computer stops the live service from being prepared'

/**
 * The file esbuild could not parse, from the output of a failed wrangler run; null when the output
 * is not that failure. `cwd`: the folder wrangler ran in, which esbuild's path is relative to.
 */
export function brokenJsonFileInOutput(output: string, cwd: string, platform: string = process.platform): { path: string } | null {
  const lines = output.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].replace(/\u001b\[[0-9;]*m/g, '')
    if (!/\[ERROR\]/.test(header) || !/\bJSON\b/.test(header)) continue
    // The place follows the error line, after at most a few blank ones.
    for (const line of lines.slice(i + 1, i + 5)) {
      if (!line.trim()) continue
      const place = /^[ \t]*(.*?(?:^|[\\/])(?:tsconfig|jsconfig|package)\.json):\d+:\d+:[ \t]*$/.exec(line)
      if (place && !place[1].startsWith('\u001b')) return { path: (platform === 'win32' ? win32 : posix).resolve(cwd, place[1]) }
      break
    }
  }
  return null
}

/** A path for showing to a person: control and direction-changing characters written out, never sent. */
export function visiblePath(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (ch) => {
    const code = ch.charCodeAt(0)
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`
  })
}

/** The message and details for that failure, in the one-line form the live paths report errors in. */
export function blockingFileText(path: string): string {
  return `${BLOCKING_FILE_MESSAGE}. Details: ${visiblePath(path)}: It is not valid JSON. Fix or move it, then try again.`
}
