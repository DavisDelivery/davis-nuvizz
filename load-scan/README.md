# load-scan

Dock loadout scanning app for Davis Delivery. Deploys to the **ddsloadout**
Netlify site (`https://ddsloadout.netlify.app`, site id
`1cca4f6e-39d8-49e4-86a5-2beae0161023`).

This is a sibling of `dispatch-map/` in the same monorepo — each subtree has its
own Netlify site. `netlify.toml` here sets `base = "load-scan"` so Netlify reads
this config (not the repo-root one) and builds only this package; `publish` and
`functions` are resolved relative to that base.

## Local

```bash
npm install
npm run dev      # vite dev server
npm run build    # → dist/
```

## Deploy check

The landing page renders `APP_VERSION`, the build commit, the deploy context and
the build time, and probes `/.netlify/functions/health` on load. A green
"Function routing OK" card means the base directory *and* the functions
directory both resolved correctly.

## Status

Scaffold only — no NuVizz, Firestore or vendor calls yet. `health.mts` is
deliberately dependency-free so it stays a clean test of routing itself.
