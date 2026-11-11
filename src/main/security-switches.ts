/** Refuse Node inspection and Chromium renderer debugging on packaged app startup. */
export function forbiddenDebuggingSwitch(args: readonly string[]): string | undefined {
  return args.find(arg => /^--(?:inspect|remote-debugging-(?:port|pipe)(?:=|$))/.test(arg))
}
