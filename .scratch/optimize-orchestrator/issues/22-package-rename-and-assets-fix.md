Type: human
Kind: task
Status: resolved
Blocked by: 17, 18

## Question

Applicare la correzione di distribuzione dopo l'audit: rinominare completamente package, binario, entrypoint e riferimenti da `legacy-cli`/`yolo` a `yano`, includere i Playbook nel pacchetto e verificare `npm pack` e installazione end-to-end senza compatibilità legacy.

## Answer

Applicata la correzione:

- package name e metadata sono `yano-orchestrator`;
- il solo binario è `yano`, con entrypoint `bin/yano.mjs`;
- script e smoke test `legacy-cli-*` sono stati rinominati `yano-*`;
- riferimenti operativi/docs/CI sono stati aggiornati da `legacy-cli`/`yolo` al nome ufficiale;
- i Playbook sono stati copiati nel percorso package `playbooks/`, incluso nel campo `files` di `package.json`;
- `yano init` copia il baseline Playbook nella workspace locale del progetto;
- `.scratch` e `.pi` non entrano nel tarball npm.

Verifiche completate:

- `node --check bin/yano.mjs` e `scripts/create-project.mjs`: pass;
- `npm run check-syntax`: pass;
- `npm run check-skill-isolation`: pass;
- `yano --help`, `yano --version`: pass;
- `yano init` su progetto temporaneo con doctor: pass;
- `npm pack` + installazione del tarball in prefisso temporaneo + `yano --help`: pass;
- `smoke-test-yano-deps`: pass.

Un test legacy rinominato (`smoke-test-yano-status`) resta fallito per una tabella SQLite `decision_holds` mancante; è un problema di schema preesistente, separato dal rename/package audit, e va risolto nel contratto persistence.

## Comments

- Task AFK eseguito dal planner il 2026-08-22.
