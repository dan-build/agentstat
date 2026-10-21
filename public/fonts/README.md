# Fonts

The demo app (`dev/App.tsx`) and its favicon expect a licensed copy of **Ogg Light Italic** at:

    public/fonts/ogg-light-italic.woff2

Ogg is a commercial typeface from Sharp Type (<https://sharptype.co/typefaces/ogg/>). It is intentionally **not** included in this repository for licensing reasons.

Without the file, the wordmark and favicon fall back to Georgia (italic, weight 300 approximated), which is visually reasonable for local development. Drop your licensed `.woff2` into this folder and the docs-matching wordmark appears automatically — no code changes needed.

This folder is dev-only. It is not part of the published npm package (`"files": ["dist"]` in `package.json` excludes it).
