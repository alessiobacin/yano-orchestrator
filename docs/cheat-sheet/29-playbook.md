# yano playbook

Esplora, verifica, trasporta e gestisce il catalogo globale dei playbook.

~~~bash
yano playbook list --json
yano playbook show knowledge-authoring --json
yano playbook check bundle.json --json
yano playbook candidates --task "Scrivere documentazione" --json
yano playbook export knowledge-authoring --out knowledge-authoring.json
yano playbook import knowledge-authoring.json --dry-run --json
yano playbook remove knowledge-authoring --yes
yano playbook purge knowledge-authoring --yes

# Audit completo o singolo capitolo
yano playbook candidates --task "audit completo: QA, architettura, UX, tool e agenti" --json
yano playbook show audit-campaign --json
yano playbook show test-adequacy-audit --json
node scripts/audit-manifest.mjs --project-root "$PWD" --output /tmp/audit-manifest.json
node scripts/audit-delegation.mjs --manifest /tmp/audit-manifest.json
node scripts/audit-resource-ledger.mjs --trace-root "$YANO_DATA_DIR/traces" --project "<nome>"
~~~

Nel piano runtime di `clean-repo`, `repo-curator` è il ruolo obbligatorio della
fase 1; `docs-sync` resta nella fase finale e `reviewer` verifica il risultato.
Il playbook deve inoltre colmare ogni categoria mancante con una directory non
vuota e contenuto reale: architettura, guide, quick guide, ADR, note,
cheat-sheet, diagramma Mermaid e, se c'è un backend, collection Postman JSON.
L'assenza di backend va dichiarata esplicitamente nel report.

Import e promozione passano dall’architect, che segnala conflitti e requisiti
mancanti. remove disabilita logicamente; purge elimina dopo conferma esplicita.

Il binding di una run non è un comando CLI: il Planner chiama il tool
orchestrator `playbook_bind` dopo `run_create` e conserva il checksum. Non
usare `yano playbook bind` da shell.

`audit-campaign` coordina QA, architettura, adeguatezza test, toolchain,
automazione, UX/prodotto e delega AI-vs-script. `standard` è il gate essenziale,
`medium` aggiunge gli assi operativi e prodotto, `deep` aggiunge mutation,
cross-command e misurazione completa. La parallelizzazione resta un gate
esplicito del Planner.

Ogni relazione deve distinguere `evidence_confidence` (solidità delle prove) da
`judgment_confidence` (autovalutazione dell'LLM), entrambe su 10, e riportare
`judgment_confidence_rationale`. `confidence` resta l'alias retrocompatibile
della confidenza nelle evidenze.
