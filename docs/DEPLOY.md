# Deploying the website

The site is one self-contained static page, `docs/index.html`, plus the images in `docs/screenshots/`. It is served at **https://talkweaver.app** (and `www.`) as Cloudflare static assets on a Worker named `talkweaver`, in the owner's Cloudflare account. Downloads link to `releases/latest/download/<stable file name>`, so a new release needs no site change.

`docs/` also holds test fixtures used by the test suite, so **never deploy `docs/` wholesale**. Stage only the page and what it references:

```sh
S=$(mktemp -d); mkdir -p "$S/public"
cp docs/index.html "$S/public/"; cp -R docs/screenshots "$S/public/"
cat > "$S/wrangler.jsonc" <<'JSON'
{
  "name": "talkweaver",
  "compatibility_date": "2026-09-16",
  "assets": { "directory": "./public" },
  "routes": [
    { "pattern": "talkweaver.app", "custom_domain": true },
    { "pattern": "www.talkweaver.app", "custom_domain": true }
  ]
}
JSON
cd "$S" && npx wrangler@latest deploy
```

Keep `assets.directory` pointing at `./public`, never `.`: otherwise the config file itself is served. Worker custom domains create their own DNS records. (A Pages custom domain attached through the API does not; if the site ever moves to Pages, create the proxied CNAMEs by hand.)

The old address **https://techczech.github.io/talkweaver-app/** still serves this page from `docs/` on `main`. A one-line script in `index.html` forwards visitors on `github.io` to talkweaver.app.

Before announcing a release: keep `docs/screenshots/home.png` public-safe, with a demo talk only, no personal files and no client slides.
