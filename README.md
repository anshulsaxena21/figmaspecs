# FigmaSpecs

Figma design inspection, layer-level specifications, project saving, and React/CSS/assets export.

## Run locally

```bash
npm install
npm run dev
```

Open the Vite URL printed in the terminal (usually `http://localhost:5173/`).

## Build

```bash
npm run build
npm run preview
```

## Deployment

The GitHub Actions workflow in `.github/workflows/deploy.yml` builds the app and publishes `dist/` to GitHub Pages.

After enabling **Settings → Pages → Build and deployment → Source: GitHub Actions**, the site is expected at:

`https://anshulsaxena21.github.io/figmaspecs/`

## Backend

The importer currently uses the existing Supabase project configured in `src/pages/FigmaImporter.jsx` and its deployed `figma-import` Edge Function. The backend/database/storage have not been migrated; existing imports and assets remain in that Supabase project.

The Figma personal access token is supplied by the user for each import and is not persisted by the application.

## Project storage

Saved designs use IndexedDB in the current browser profile. These local saves are not cloud-synced. Export a JSON backup or ZIP to move a saved project to another device.

## Export formats

- Complete project ZIP (design JSON, layer JSON/CSV, CSS tokens, generated starter code and assets)
- React + CSS ZIP
- Layer descriptions JSON/CSV
- Design JSON and CSS tokens
