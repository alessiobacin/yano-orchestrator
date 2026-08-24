Type: human
Kind: grilling
Status: resolved
Blocked by: 12, 17

## Question

Da quale percorso autorevole deve caricare il runtime i Playbook, come devono essere inclusi nel pacchetto `yano-orchestrator` e come vanno selezionati per progetto, dominio e versione? Definire precedence tra asset package/locali, anti-path-traversal, checksum/immutabilità, errore di asset mancante e verifica sul pacchetto installato.

## Answer

I Playbook distribuiti vivono in un percorso esplicito incluso nel package manifest, ad esempio `playbooks/`, non sotto `.pi/`. La precedenza è: Playbook locali di progetto solo se esplicitamente configurati, poi Playbook inclusi nel pacchetto; non esistono fallback impliciti verso altri file o directory.

Ogni Playbook caricato viene verificato con `id`, versione, schema, checksum e origine, e resta immutabile per tutta la durata del run.

Se il Playbook richiesto manca, è incompatibile, alterato o ha checksum non corrispondente, il runtime blocca il run e non sostituisce automaticamente il file con `default`.

Il loader rifiuta path traversal, symlink fuori dalla root autorizzata e riferimenti a file non inclusi nel manifest. `yano init` installa o copia Playbook nel progetto solo dopo verifica di checksum e compatibilità.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
