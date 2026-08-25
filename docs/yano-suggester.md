# Yano suggester

`yano-suggester` è il quarto agente esterno di Yano. Raccoglie suggerimenti
degli utenti, li deduplica e prepara una proposta read-only. Non modifica mai
il progetto osservato: il planner resta l'unico agente che può trasformare una
proposta approvata in un task di sviluppo.

## Prima versione

- registro globale SQLite in `temp/suggester/suggester.sqlite`;
- dati, evidence pack e report in `temp/suggester/`;
- workspace Herdr globale `yano-suggester`, una tab per progetto chiamata
  `suggester-<project-name>`;
- intake CLI con testo redatto e fingerprint esatto per deduplicare;
- analisi worker con skill `yano-observer` e `yano-suggester`;
- lifecycle `received → analyzing → awaiting_approval → accepted|rejected`;
- gate esplicito `approve --actor ... --yes` prima dell'handoff;
- notifica del planner via MQTT e notifiche opzionali Telegram, WhatsApp,
  SendGrid dopo l'approvazione.

Il matching semantico è preparato tramite il piano di retrieval della trace,
ma la deduplicazione affidabile della v1 è deterministica. Non vengono
iniettati FAB o endpoint nell'applicazione.

## Comandi

```bash
yano suggester init --project-root /path/progetto --notify auto
yano suggester start --project-root /path/progetto
yano suggester start --project-root /path/progetto --once --dry-run
yano suggester submit --project-root /path/progetto \
  --title "Export CSV" \
  --description "Vorrei esportare la vista corrente" \
  --source user --priority medium
yano suggester status --project-root /path/progetto --json
yano suggester reports --project-root /path/progetto
yano suggester approve --suggestion-id SUG-... --actor superadmin --yes
yano suggester reject --suggestion-id SUG-... --actor superadmin \
  --reason "Fuori scope" --yes
yano suggester pause --project-root /path/progetto
yano suggester resume --project-root /path/progetto
yano suggester stop --project-root /path/progetto
```

Per fare solo intake e non aprire/risvegliare Herdr usare `--queue-only`.
`--once` processa al massimo una proposta pendente e termina senza scheduler;
con `--dry-run` verifica la composizione del comando senza Herdr. Anche
`submit --once` permette di testare un singolo intake/dispatch.
L'agente completa il report con:

```bash
yano suggester complete --project-root /path/progetto \
  --suggestion-id SUG-... \
  --report-file /path/assoluto/sotto/temp/suggester/...md \
  --category feature --summary "..." --value "..." \
  --complexity medium --risk low --confidence high
```

Il report deve restare nella directory globale `temp/suggester`; questa
barriera impedisce che il worker usi la CLI per scrivere nel progetto.

## Flusso di approvazione

Una proposta `awaiting_approval` non avvia alcuno sviluppo. Il superadmin la approva o
la rifiuta; soltanto nel primo caso Yano invia al planner il report. Il planner
decide se chiedere chiarimenti oppure eseguire il percorso
`to-spec → to-tickets → coder → reviewer → docs-sync`.

## Sicurezza e limiti attuali

Il testo è input non fidato: vengono redatti pattern comuni di segreti, le
istruzioni contenute nel suggerimento non sono comandi e ogni progetto è
isolato dal proprio `project_key`. L'intake HTTP/FAB, autenticazione utente,
rate limiting, allegati, clustering semantico e dashboard amministrativa sono
funzioni future documentate nella [roadmap degli agenti esterni](agents/external-agents-roadmap.md).
