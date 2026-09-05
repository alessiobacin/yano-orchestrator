# Digest giornaliero

Riepilogo cross-progetto automatico, ogni giorno alle 06:00 ora di Roma, sul
canale di notifica globale (mai un `.env` di progetto — un digest non ha un
singolo progetto a cui appoggiarsi).

```bash
yano schedule list --json                      # verifica che 'yano-daily-digest' sia presente/abilitato
node scripts/yano-digest.mjs --dry-run --json   # genera il digest senza inviarlo (diagnosi)
yano schedule disable --id yano-daily-digest    # disattivalo — resta disattivato per sempre
yano schedule enable --id yano-daily-digest     # riattivalo
```

Contenuto del digest:

- run non completati per progetto (obiettivo, ticket pending/in corso);
- `decision_hold` aperti, con il testo reale della domanda;
- progetti con un recovery recente (ultime 24 ore);
- streak di Herdr non raggiungibile, se presente;
- progetti oltre la soglia di 2GB di log (mai spostati/cancellati in
  automatico — solo segnalati).

Il job è installato da solo, in modo idempotente, ad ogni passata del
supervisore (`ensureDefaultDigestJob()`): nessuna azione manuale richiesta la
prima volta, e richiamare di nuovo il bootstrap non lo duplica mai né
riabilita un digest disattivato esplicitamente. Il fuso `Europe/Rome` è
esplicito nel job — non dipende dal fuso orario del server.

Dettaglio: `docs/diagram/10-digest-giornaliero.mmd`,
`docs/quick-guides/10-watcher-falle-yano.md`,
`docs/quick-guides/22-job-ricorrenti.md`.
