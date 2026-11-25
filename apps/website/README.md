# DiRouter website

The Persian, RTL public homepage uses the selected Orbit design, the Fold logo, and the `#2864F0` brand color. It is a separate workspace application; the administration dashboard is unchanged.

## Run locally

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @dirouter/website dev
```

The development server binds to `http://127.0.0.1:5174/`. For an explicitly requested LAN preview, pass `--host 0.0.0.0`. No gateway, database, API credentials, or external font service is required for the website.

## Production build

```sh
pnpm --filter @dirouter/website build
pnpm --filter @dirouter/website preview --host 127.0.0.1 --port 4174
```

The build type-checks the application and writes the static site to `apps/website/dist/`. Serve that directory at the root of the public site. Current Compose services and the production domain are not changed by this application. The site contains no signup, authentication, or billing integration.

## Interaction and motion

- The routing lab is an explicitly labeled simulation. Normal routing selects OpenAI, failover demonstrates switching to Anthropic, and the cost-policy example selects Mistral. It does not call a provider or show real operational metrics.
- Switching a scenario cancels pending timers. The simulation may be rerun after completion.
- TypeScript, Python, and cURL examples share keyboard-accessible tabs and a copy action with success/failure feedback. Users must supply their own endpoint, virtual key, and configured model alias.
- SVG route particles, gentle node motion, and pointer parallax animate the hero. A global pause control is available. Motion respects `prefers-reduced-motion` and pauses when the document is hidden.
- Sections reveal as they enter the viewport. Content remains visible when reduced motion is requested or motion is paused.
- Mobile navigation supports Escape and returns focus to its toggle. FAQ entries use native disclosure controls.

## Assets and dependencies

The logo and favicon live under `public/`. Vazirmatn is self-hosted through `@fontsource-variable/vazirmatn`; its SIL Open Font License is included with the dependency. Icons are imported individually from `lucide-react`. No external scripts, fonts, telemetry, or images are fetched at runtime.

## Validation

The production build includes strict TypeScript checking. Browser smoke checks cover all routing scenarios, switching scenarios, code tabs and copy, FAQ disclosure, motion pause, mobile navigation, and responsive layouts at 320, 390, 768, and 1440 CSS pixels.
