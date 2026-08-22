Type: task
Status: resolved
Blocked by: 06, 11

## Question

Eseguire un audit di distribuzione del pacchetto per garantire che il nome ufficiale sia `yano-orchestrator`, che il solo binario sia `yano`, che Playbook e asset necessari siano inclusi e che installazione, `yano init`, `yano start`, `yano update` e `yano uninstall` funzionino da un pacchetto installato.

## Answer

Audit eseguito il 2026-08-22 con `node --check bin/po.mjs` e `npm pack --dry-run --json`.

Risultato: il pacchetto non è conforme alla destinazione `yano`.

- `package.json` dichiara `name: yolo-orchestrator` e `bin.po: ./bin/po.mjs`.
- Il solo entrypoint presente è `bin/po.mjs`; la CLI `yano` non è ancora esposta.
- Il dry-run npm pubblica il pacchetto senza gli asset Playbook sotto `.pi/`, perché `.pi/` è escluso dal `.gitignore` e non è incluso nel package manifest.
- La sintassi dell'entrypoint esistente è valida, ma non verifica la conformità dei nomi o la distribuzione dei Playbook.

Il task di audit è concluso con failure documentata. La correzione richiede l'implementazione della rinomina completa, un asset path/package manifest esplicito per i Playbook e una nuova verifica su pacchetto installato.

## Comments

- Audit AFK eseguito dal planner il 2026-08-22.
