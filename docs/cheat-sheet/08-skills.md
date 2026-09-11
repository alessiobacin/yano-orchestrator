# yano skills

Controlla e sincronizza le skill vendorizzate e quelle installabili.

~~~bash
yano skills status
yano skills install --dry-run
yano skills install
yano skills install --no-prune

La skill `stitch-design-redesign` viene passata automaticamente dal launcher a
`design-redesign-specialist`, ai ruoli frontend e ai ruoli full-stack. L'istanza
standard è `design-redesign-01`; il relativo MCP Stitch resta configurato nel
`.mcp.json` del progetto.
~~~

Dopo un aggiornamento globale, rieseguire la sincronizzazione delle skill del
progetto con pi update -extensions quando richiesto dalla procedura locale.
