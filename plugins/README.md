# Provider plugins

Each folder here is a provider plugin: a `plugin.json` manifest and one JavaScript file. Plugins
load only when listed in `PLUGINS_ENABLED` (for example `PLUGINS_ENABLED=workers-ai`) and are
read from `PLUGINS_DIR` (this folder by default).

`workers-ai` is the reference plugin. See `docs/` for the plugin interface and the sandbox rules.
