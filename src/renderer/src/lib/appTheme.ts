// Electron applies the stored Theme to the app's media query. System follows the OS;
// the renderer listens so already-open windows update alongside newly opened ones.
const darkAppearance = window.matchMedia('(prefers-color-scheme: dark)')
const apply = (): void => {
  document.documentElement.dataset.theme = darkAppearance.matches ? 'dark' : 'light'
}
apply()
darkAppearance.addEventListener('change', apply)
