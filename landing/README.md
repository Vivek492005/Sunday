# Sunday Landing Page

Static marketing site for Sunday — the agent-first coding IDE.

## Preview locally

No build step needed. Any static server works:

```sh
# Python
cd landing && python3 -m http.server 8080

# Node
cd landing && npx serve .

# Or just open index.html directly (file:// works too)
```

Then visit `http://localhost:8080`.

## Deploy to GitHub Pages

### Option A — automatic (recommended)

Add `.github/workflows/landing.yml`:

```yaml
name: Deploy landing page
on:
  push:
    branches: [main]
    paths: ['landing/**', '.github/workflows/landing.yml']
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.d.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: landing
      - id: d
        uses: actions/deploy-pages@v4
```

Then in repo **Settings → Pages → Source**, choose **GitHub Actions**.

The site will be live at `https://vivek492005.github.io/Sunday/`.

### Option B — manual

```sh
# From repo root, publish landing/ to the gh-pages branch
git subtree push --prefix landing origin gh-pages
```

Then set Pages source to the `gh-pages` branch.

### Custom domain (optional)

1. Add a `CNAME` file in `landing/` containing your domain (e.g. `sunday-ide.dev`).
2. In your DNS, add a `CNAME` record → `vivek492005.github.io`.
3. In repo Settings → Pages, enforce HTTPS.

## Files

| File | Purpose |
|---|---|
| `index.html` | All 13 sections: nav, hero, stats, features, how-it-works, demo, architecture, showcase, use cases, editions, download, docs, footer |
| `styles.css` | Design system: dark theme, sunrise gradient, glassmorphism, responsive |
| `script.js` | Typing animations, particles, tilt, count-ups, tabs, copy buttons (<14KB) |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

## Notes

- **No build, no framework, no dependencies.** Works via `file://` and any static host.
- **Fonts:** system stacks only (no Google Fonts dependency) — fast and offline-friendly.
- **Motion:** all animations respect `prefers-reduced-motion`.
- **Download URLs** point at the real `v0.1.0` GitHub release assets.
- Keep this directory **out of the release VSIX** — it's marketing, not product.
- Total size: ~55KB (HTML + CSS + JS, uncompressed).
