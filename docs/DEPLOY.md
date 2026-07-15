# Deploying the website

The site is a single self-contained static page in `docs/` (mirrors the SlideWell / Highlight
Scout setup). Downloads link to the GitHub **Releases** built by `.github/workflows/release.yml` —
the site and the builds are independent.

## GitHub Pages (current)
Served from `docs/` on `main` at **https://techczech.github.io/talkweaver-app/**.
Enable once in **Settings → Pages → Source: Deploy from a branch → main / docs**, or via
`gh api repos/techczech/talkweaver-app/pages`.

## Custom domain: talkweaver.app
The page's canonical is `https://talkweaver.app/`. To serve it there:
- **GitHub Pages custom domain:** add `talkweaver.app` under Settings → Pages, add a `CNAME`
  file to `docs/`, and point DNS (A/ALIAS to GitHub Pages, or CNAME to techczech.github.io).
- **or Cloudflare Pages:** `npx wrangler pages deploy docs --project-name talkweaver` and attach
  `talkweaver.app` as the custom domain.

## Before announcing
- The build is **not notarised/signed yet** (Apple Developer enrolment pending) — the page tells
  users the `xattr -cr` / SmartScreen step. Update this copy once signed builds ship.
- Keep `docs/screenshots/home.png` a public-safe screenshot (no real client slides).
