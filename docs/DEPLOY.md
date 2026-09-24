# Deploying the website

The site is one self-contained static page in `docs/` (`index.html`, plus `screenshots/` and
`assets/`). Download buttons point at the stable file names on the latest GitHub Release
(`releases/latest/download/TalkWeaver-mac-arm64.dmg` and
`releases/latest/download/TalkWeaver-windows-x64-setup.exe`), built by
`.github/workflows/release.yml`. The site and the builds are deployed independently.

## Host: Cloudflare Pages

- **Project name:** `talkweaver`
- **Deployed from:** the `docs/` folder
- **Default address:** `https://talkweaver.pages.dev`
- **Custom domains:** `talkweaver.app` and `www.talkweaver.app`
- **Canonical:** `https://talkweaver.app/` (set in `index.html`; keep it)

Deploy:

```sh
npx wrangler pages deploy docs --project-name talkweaver
```

### Custom domains need a DNS record each

Attaching a custom domain to the Pages project (in the dashboard or through the API) reports
success but creates **no DNS record**. The domain stays "pending" until you add the record
yourself. For each name, create a **proxied CNAME** in the `talkweaver.app` zone:

| Name | Type | Target | Proxy |
|---|---|---|---|
| `talkweaver.app` (apex, `@`) | CNAME | `talkweaver.pages.dev` | Proxied |
| `www` | CNAME | `talkweaver.pages.dev` | Proxied |

Cloudflare flattens the apex CNAME. After both records exist, check that each domain shows
"Active" in the Pages project and that `https://talkweaver.app/` and
`https://www.talkweaver.app/` serve the page.

## GitHub Pages (old address)

The site used to be served by GitHub Pages at `https://techczech.github.io/talkweaver-app/`.
That address should redirect to `https://talkweaver.app/`. GitHub Pages cannot send a server
redirect for a project site, so either keep a minimal page there with a
`<meta http-equiv="refresh">` and a canonical link to `https://talkweaver.app/`, or turn GitHub
Pages off once links have moved.

## Regenerating the images

- **Gallery** (`screenshots/slides/*.png`): render `docs/gallery-source.md` with the TalkWeaver
  compiler (`prepareSource` + `buildDeckHtmlFromModel`), then screenshot each slide's
  `.stage > .slide.active` at 1280×720, device scale factor 2. The comment above each slide in
  the source names its PNG.
- **Hero** (`screenshots/home.png`): the dev build launched hidden with a temporary vault and a
  temporary `--user-data-dir` (as the e2e temp-vault gates do), with the gallery talk open, the
  action bar showing and the Inspector open; window content 1352×880 at device scale factor 2.
  Never capture from a real vault or real user data.

## Before announcing

- Keep every screenshot public-safe: only the gallery talk, no real client slides or vault
  content.
- Check that both download links resolve once the release with the stable file names is out.
