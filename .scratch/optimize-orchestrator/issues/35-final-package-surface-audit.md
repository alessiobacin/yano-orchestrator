Type: task
Status: resolved
Blocked by: 06, 17, 22

## Question

Verificare il tarball installabile e l’assenza di identificatori legacy nella superficie pubblica e nei test di packaging.

## Resolution

`npm pack` produce `yano-orchestrator@1.2.8` con `bin/yano.mjs`, Playbook e script `yano-*`; installazione temporanea e `yano --version/--help` verificati. Rinominato l’ultimo identificatore interno `PO_BIN` in `YANO_BIN` in `smoke-test-copy-prompts.mjs`. Nessun riferimento legacy rilevato nella superficie pubblica esclusi tracker/storia e directory runtime storiche.
