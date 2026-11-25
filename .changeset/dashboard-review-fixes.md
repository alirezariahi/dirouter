---
'@dirouter/dashboard': patch
'@dirouter/portal': patch
---

Safer dashboard forms and exports: the MCP tool allow-list refuses an empty selection in "only the selected tools" mode (an empty list means every tool); leaving the Playground aborts its running streams; CSV exports prefix text cells that a spreadsheet would run as a formula (amounts stay plain numbers) and the usage report uses the same exporter; dashboard and portal downloads click a link that is in the document and revoke its URL after the click.
