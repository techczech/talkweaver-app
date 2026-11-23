import { chromium } from 'playwright'

export const launchEditorTestBrowser = () => chromium.launch({ headless: true })

export function reportMissingEditorTestBrowser(error) {
  if (!error.message.startsWith("browserType.launch: Executable doesn't exist at ")) throw error
  console.log('TEST NOT RUN: Playwright Chromium headless shell is missing. Run npx playwright install chromium.')
}
