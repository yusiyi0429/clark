# Meeting Material parser Alpine probe — 2026-09-20

## Scope

This is a disposable, read-only-to-the-repository dependency probe. It did not modify `package.json`, `pnpm-lock.yaml`, API code, database, Docker Compose, or named volumes.

## Environment

- Image: `node:22.13-alpine`
- Digest: `sha256:e2b39f7b64281324929257d0f8004fb6cb4bf0fdfb9aa8cedb235a766aec31da`
- Architecture: `arm64`
- Alpine: `3.21.2`
- Node: `v22.13.1`
- Process identity: `uid=1000(node) gid=1000(node)`
- Temporary dependencies only: `pdfjs-dist@5.4.296`, `mammoth@1.12.3`, `jszip@3.10.1`, `sanitize-html@2.17.0`

## Verified

1. All four packages installed and imported in `node:22.13-alpine` without adding a native build toolchain.
2. `pdfjs-dist/legacy/build/pdf.mjs` extracted `CEO material` from a generated one-page PDF and the probe rejected an otherwise valid PDF with no text content as `empty_text_layer`.
3. `mammoth.extractRawText` returned `Board decision` from a minimal OOXML DOCX.
4. `mammoth.convertToHtml({ externalFileAccess: false })` plus an explicit `sanitize-html` allowlist stripped an image/event handler, inline style and `javascript:` URL. Result: `<h1>Title</h1><p>Board decision</p><a>bad</a>`.
5. `JSZip` exposed an entry's uncompressed byte count (`1,048,576`), sufficient for a pre-extraction ZIP size guard.

`pdfjs-dist` emitted `Ensure that the standardFontDataUrl API parameter is provided` while extracting the generated standard-font PDF. Extraction still succeeded. The implementation must configure this deliberately or suppress only this known non-fatal warning after verifying normal uploaded PDFs.

## Not verified

This is not a security sign-off. It did not run real password-protected/corrupt/scanned PDFs, real DOCX with images/external relationships, a genuine ZIP bomb, timeout termination, peak-memory measurement, amd64, API-volume permissions, upload atomicity, or database cleanup. Those remain Ticket 19 integration acceptance checks.

## Decision

The selected pure-JS package path is viable on the target Node/Alpine runtime for a minimal PDF text extraction, DOCX text extraction, sanitized HTML conversion, and ZIP metadata check. Add exact versions to the API manifest and lockfile only with the Ticket 19 implementation change.
