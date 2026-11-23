# Font licences

All fonts in this directory are licensed under the SIL Open Font License, Version 1.1:
https://openfontlicense.org/open-font-license-official-text/ . The table under "Slide typefaces" gives each
file's source, version and checksum.

- **Inter** — Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter). SIL OFL 1.1.
- **Geist** — Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font). SIL OFL 1.1.
- **Fraunces** — Copyright 2018 The Fraunces Project Authors
  (https://github.com/undercasetype/Fraunces). SIL OFL 1.1.
- **Alegreya Sans** — Copyright 2013 The Alegreya Sans Project Authors
  (https://github.com/huertatipografica/alegreya-sans). SIL OFL 1.1.
- **JetBrains Mono** — Copyright 2020 The JetBrains Mono Project Authors
  (https://github.com/JetBrains/JetBrainsMono). SIL OFL 1.1.

The OFL permits bundling, embedding, and redistribution of the fonts with
software, provided they are not sold by themselves and the copyright and
licence notices are retained.

## Slide typefaces (0.44.5)

Every slide font file is an unmodified WOFF2 file from the Fontsource npm packages listed below. Fontsource
redistributes the Google Fonts builds and Google's own `latin` and `latin-ext` subsets; nothing was subset,
instanced or re-encoded in this repository. Fontsource packages: https://github.com/fontsource/font-files.

Reproduce (any machine with npm):

```sh
npm pack @fontsource/inter@5.3.0 @fontsource-variable/geist@5.3.0 @fontsource/fraunces@5.3.0 \
  @fontsource/alegreya-sans@5.3.0 @fontsource/jetbrains-mono@5.3.0
# untar each and copy package/files/<file name below>; check with: shasum -a 256 <file>
```

The `unicode-range` values in `compiler/assets/styles/skin/zz-x-ocean-05-type.css` are the ones the same packages
declare for each subset. The build (`scripts/build-deck-styles.mjs`) embeds the bytes as `data:` URLs, so no font
request reaches the network. Upstream projects: Inter https://github.com/rsms/inter (build git-66647c0bb),
Geist https://github.com/vercel/geist-font, Fraunces https://github.com/undercasetype/Fraunces, Alegreya Sans
https://github.com/huertatipografica/alegreya-sans, JetBrains Mono https://github.com/JetBrains/JetBrainsMono.
Full OFL texts sit beside the fonts.

| File | Source (package, path) | Version (name table) | Licence | SHA-256 |
|---|---|---|---|---|
| `alegreya-sans-latin-400-normal.woff2` | `@fontsource/alegreya-sans@5.3.0` `files/alegreya-sans-latin-400-normal.woff2` | 2.004  ttfautohint (v1.6) | OFL 1.1, `ALEGREYA-SANS-OFL.txt` | `b2a5a35a2563a2f9bf9fb91939fc6ea6c115e9811cda5c4a37d02f623c7c4dbe` |
| `alegreya-sans-latin-700-normal.woff2` | `@fontsource/alegreya-sans@5.3.0` `files/alegreya-sans-latin-700-normal.woff2` | 2.004  ttfautohint (v1.6) | OFL 1.1, `ALEGREYA-SANS-OFL.txt` | `5acd19a588614d23e52b741a21dd8555178ab4932c3195c6d8fb4b296f84acae` |
| `alegreya-sans-latin-ext-400-normal.woff2` | `@fontsource/alegreya-sans@5.3.0` `files/alegreya-sans-latin-ext-400-normal.woff2` | 2.004  ttfautohint (v1.6) | OFL 1.1, `ALEGREYA-SANS-OFL.txt` | `c76008bc2a70ed1bdfd00cf5639e6a7163b7f1a095e50aac94d8c8dcd5eab337` |
| `alegreya-sans-latin-ext-700-normal.woff2` | `@fontsource/alegreya-sans@5.3.0` `files/alegreya-sans-latin-ext-700-normal.woff2` | 2.004  ttfautohint (v1.6) | OFL 1.1, `ALEGREYA-SANS-OFL.txt` | `8f289f338a955d3a9d51cd59a0a99e96627fe54d3c54859f4eeeacb9f24b80bc` |
| `fraunces-latin-600-normal.woff2` | `@fontsource/fraunces@5.3.0` `files/fraunces-latin-600-normal.woff2` | 1.000 [b76b70a41] | OFL 1.1, `FRAUNCES-OFL.txt` | `3a1de7711d147bad4422825045f87597fd77cca72e7c96d3b0a81735d00dda82` |
| `fraunces-latin-ext-600-normal.woff2` | `@fontsource/fraunces@5.3.0` `files/fraunces-latin-ext-600-normal.woff2` | 1.000 [b76b70a41] | OFL 1.1, `FRAUNCES-OFL.txt` | `69e09c7910e64d829e051f023af4c38a2e74b61d9e9439502f56edd7154b117c` |
| `geist-latin-ext-wght-normal.woff2` | `@fontsource-variable/geist@5.3.0` `files/geist-latin-ext-wght-normal.woff2` | 1.800 | OFL 1.1, `GEIST-LICENSE.txt` | `824f485b5d26e2f2da3c2b236132ece1bc8e4e43373452950bb0e40548b4313f` |
| `geist-latin-wght-normal.woff2` | `@fontsource-variable/geist@5.3.0` `files/geist-latin-wght-normal.woff2` | 1.800 | OFL 1.1, `GEIST-LICENSE.txt` | `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1` |
| `inter-latin-300-normal.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-300-normal.woff2` | 4.001 git-66647c0bb | OFL 1.1, `INTER-LICENSE.txt` | `be0276550393a72b94d673505567dceba801511d5e1ca5a87793190dc5d5a6ca` |
| `inter-latin-400-normal.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-400-normal.woff2` | 4.001 git-66647c0bb | OFL 1.1, `INTER-LICENSE.txt` | `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc` |
| `inter-latin-600-normal.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-600-normal.woff2` | 4.001 git-66647c0bb | OFL 1.1, `INTER-LICENSE.txt` | `f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a` |
| `inter-latin-700-normal.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-700-normal.woff2` | 4.001 git-66647c0bb | OFL 1.1, `INTER-LICENSE.txt` | `6f56409fd3d64bb85f7d070bce20749db2d66b6d63cec586cc22d1c761be2491` |
| `inter-latin-ext-300-normal.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-ext-300-normal.woff2` | 4.001 git-66647c0bb | OFL 1.1, `INTER-LICENSE.txt` | `b11def546ac052fad7993e39c53801b55af99b0fd51a9ac0e72884b5c3fcaa3f` |
| `inter-latin-ext-400-normal.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-ext-400-normal.woff2` | 4.001 git-66647c0bb | OFL 1.1, `INTER-LICENSE.txt` | `6744a7f509ebc6ab220a6cd4ea77e898adf014f03d88dcda5d45d8a9feefb4e9` |
| `inter-latin-ext-600-normal.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-ext-600-normal.woff2` | 4.001 git-66647c0bb | OFL 1.1, `INTER-LICENSE.txt` | `e4bdf67b0cd15ca9e184509275be95db942195d3cc2b17f6a0452f2adf75d0bf` |
| `inter-latin-ext-700-normal.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-ext-700-normal.woff2` | 4.001 git-66647c0bb | OFL 1.1, `INTER-LICENSE.txt` | `143f9504f1377012aa3e39c90c4354ef429cb0494b9ac0e1437f1a81e5412236` |
| `jetbrains-mono-latin-400-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` `files/jetbrains-mono-latin-400-normal.woff2` | 2.211 | OFL 1.1 (notice above) | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |

Known gaps, accepted for 0.44.5: no italic files are shipped (emphasis uses browser-synthesised slant to keep
offline exports small); arrows other than ↑ ↓, and symbols such as → ← ≤ ≥ ✓, are outside the upstream Latin
subsets and render in a fallback face.
