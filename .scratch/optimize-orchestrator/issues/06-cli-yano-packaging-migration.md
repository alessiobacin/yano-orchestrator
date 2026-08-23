Type: grilling
Status: resolved

## Question

Come deve essere completata la rinomina del CLI pubblico da `legacy-cli` a `yano`? Definire il nome del binario npm, riferimenti negli script e nel codice, documentazione e messaggi utente, eventuale periodo di compatibilità per `legacy-cli`, comportamento di `yano update`/`uninstall`, e criteri per verificare che il pacchetto installato esponga il comando corretto.

## Answer

La rinomina è completa e senza compatibilità retroattiva: `package.json` espone esclusivamente il binario `yano` e il comando `legacy-cli` deve sparire, senza alias o shim.

Tutti i riferimenti pubblici e operativi devono usare `yano`: README, quickstart, messaggi CLI, script, workflow e istruzioni. La rinomina comprende anche file e identificatori interni, incluso il precedente entrypoint `legacy-cli.mjs`.

Il nome ufficiale del progetto/package è `yano-orchestrator`. Non devono restare riferimenti storici al nome precedente nella superficie del progetto.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
