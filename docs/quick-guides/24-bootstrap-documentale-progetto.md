# Bootstrap documentale di un progetto esistente

Quando viene avviato un planner su un progetto non vuoto, Yano esegue una
scansione leggera prima dell’esplorazione profonda del codice. Rileva manifest,
directory principali, entrypoint candidati e stato delle categorie sotto
`docs/`.

Il risultato viene salvato nella memoria condivisa:

```text
.pi/extensions/yano-orchestrator/memory/project.md
```

Se il file manca, Yano crea solo questo riepilogo breve. Non crea o modifica
guide, diagrammi, note o cheat-sheet senza una conferma esplicita dell’utente.

## Flusso

1. Il planner legge `project.md`.
2. Presenta la scansione e segnala documenti mancanti o potenzialmente
   obsoleti.
3. Chiede se l’utente vuole avviare `docs-sync`.
4. Dopo la conferma, `docs-sync` confronta i documenti esistenti con codice,
   configurazione e test reali, aggiornando quelli obsoleti e creando quelli
   mancanti applicabili.
5. Il planner verifica i file realmente modificati e aggiorna `project.md`
   con riferimenti e stato finale. `docs-sync` non sovrascrive il riepilogo.

Se l’utente rifiuta, il planner registra la decisione e continua senza
inventare documentazione o fatti sul progetto.
