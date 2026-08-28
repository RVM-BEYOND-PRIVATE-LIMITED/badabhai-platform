# Font-probe fixtures

Real WeasyPrint output, kept as bytes because the failure they document is invisible
in everything else: all three renders **exited 0** and produced a valid one-page PDF.

`probe.html` is `RESUME_FONT_PROBE_HTML` verbatim — `resume-fonts.test.ts` asserts the
two are identical, so editing the constant without re-rendering these turns them into
bytes from a document that no longer exists.

| fixture           | container                                  | faces embedded                                        |
| ----------------- | ------------------------------------------ | ----------------------------------------------------- |
| `full-fonts.pdf`  | the shipped image                          | `Noto-Sans`, `Noto-Sans-Devanagari`                   |
| `no-noto.pdf`     | ...minus `fonts-noto-core`                 | `DejaVu-Sans` — the Devanagari line is .notdef boxes  |
| `no-sans.pdf`     | ...minus the DejaVu *sans* faces as well   | `DejaVu-Serif` — a serif sheet, every glyph present   |

## Regenerating

WeasyPrint is Docker-only on Windows (`docs/resume-pdf-render-local.md`). Build the
image once from `apps/api/Dockerfile`'s runtime stage, then, from this directory:

```sh
FX=$(pwd)
render() {  # $1 = font-removal prep, $2 = output name
  MSYS_NO_PATHCONV=1 docker run --rm -v "$FX:/fx" bb-weasy:local \
    sh -c "$1 weasyprint /fx/probe.html /fx/$2"
}
render 'true;' full-fonts.pdf
render 'rm -rf /usr/share/fonts/truetype/noto && fc-cache -f >/dev/null 2>&1;' no-noto.pdf
render 'rm -rf /usr/share/fonts/truetype/noto /usr/share/fonts/truetype/dejavu/DejaVuSans*.ttf && fc-cache -f >/dev/null 2>&1;' no-sans.pdf
```

Deleting the font FILES rather than the packages is deliberate: `dpkg --remove` would
also drag out anything depending on them, and the state being reproduced is "the image
was built without this package", not "someone uninstalled it".

Removing **both** font directories entirely is not a fourth tier — Pango segfaults
(exit 139) with no fonts at all, which is a loud failure and needs no guard.
