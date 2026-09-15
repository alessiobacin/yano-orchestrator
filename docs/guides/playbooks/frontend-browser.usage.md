# `frontend-browser` — implementazione, E2E e review visuale

Il planner seleziona questo playbook quando il task ha impatto sulla
superficie frontend: screenshot, route browser, form, toast, componenti,
stili, payload creati dal client o comportamento visibile. La classificazione
si basa sulla superficie interessata, anche quando la causa tecnica è nel
backend.

## Flusso obbligatorio

Il flusso standard è:

`frontend-developer → frontend-reviewer → e2e-simulator → docs-sync`

`frontend-developer` implementa e raccoglie test/screenshot o trace;
`frontend-reviewer` controlla il comportamento reale nel browser, console,
network e gli assi Spec/Standards; `e2e-simulator` esegue il percorso utente
interessato e registra l'evidenza automatizzata. In un task misto, il ciclo
`coder → reviewer` copre separatamente il backend.

Se il frontend non è avviabile o non esiste un harness realistico, il planner
deve registrare `e2e_tests_skipped_reason` con il comando tentato, l'errore e
la verifica alternativa. Non è valido dichiarare E2E eseguito senza evidenza.

### Account di test per il login

Quando il progetto ha autenticazione, il coder deve rilevare i ruoli
applicativi e predisporre nel worktree/sandbox un account development/test per
ciascun ruolo utente previsto dall'applicazione, non solo per il primo
percorso E2E. Se il dominio richiede un'azienda,
deve predisporre anche l'azienda test e il legame utente-azienda. Le credenziali
sono generate o configurate solo per development/test, registrate cifrate nel
registro sicuro Yano e passate a Playwright tramite variabili d'ambiente
temporanee; non vanno scritte nei report, trace, screenshot o codice. Se lo
schema di autenticazione non consente il provisioning automatico, il coder
deve documentare il comando/fixture riproducibile e il planner deve bloccare
l'E2E con una motivazione esplicita, senza inventare credenziali.

## Gate di review visuale

Dopo l’approvazione frontend/E2E e prima della chiusura, il planner offre la
review visuale all’utente e registra la risposta esplicita. Se accetta, verifica
l’URL dev reale e usa l’adapter DOM:

```bash
yano feedback-api start --no-open
yano frontend-review browser --url http://localhost:8501
```

Il bookmarklet raccoglie annotazioni e screenshot tramite l’API Yano. Non
richiede dipendenze React. Le correzioni rientrano nel ciclo frontend e nei test.
Agentation `setup`/`start` resta opzionale per integrazioni legacy.
I campi di finalize `agentation_*` mantengono i nomi per compatibilità e
registrano l’esito anche della review DOM. Uso, opt-out e limiti browser nella
[guida Yano essenziale](../../quick-guides/yano-essential.md).
