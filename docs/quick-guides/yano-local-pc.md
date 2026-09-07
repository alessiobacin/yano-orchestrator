# Local PC

`yano-local-pc` è il servizio logico globale persistente nel workspace Herdr
`yano-local-pc`. L’unico processo LLM persistente del control plane è il suo
`planner-01`: il servizio non avvia un secondo agente Pi usa-e-getta. Watcher,
feedback e scheduler verificano e ripristinano sempre quel planner.

Non è un progetto e quindi non compare in `yano watcher projects`. La sua
supervisione però resta attiva: ogni passata globale verifica workspace, tab,
processo, stato Herdr, heartbeat applicativo e identità `planner-01`; se è
chiuso, bloccato, stantio o sostituito dall’agente sbagliato, lo ricrea.
Architect e auto-improver sono invece worker on-demand e vengono riconciliati
tramite i rispettivi registri quando il loro lavoro lo richiede.
L'assenza di task non è una condizione di chiusura: se pane, processo e
heartbeat sono sani, il cron lascia il planner aperto e non lo ricrea.

I server Apple sono caricati esclusivamente dalla configurazione runtime del
servizio, mai dai `.mcp.json` dei progetti. Sono disponibili Notes, Messages,
Contacts, Reminders, Calendar, Maps, Mail e Voice Memos. Voice Memos richiede
la configurazione globale segreta `YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY`;
senza questa chiave gli altri server restano disponibili.

Per abilitarlo, inserire la chiave senza passarla sulla riga di comando:

```sh
read -s ASSEMBLYAI_KEY
printf '%s' "$ASSEMBLYAI_KEY" | yano config set YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY --stdin
unset ASSEMBLYAI_KEY
```

```sh
yano local-pc start
yano local-pc status
yano local-pc ask --prompt "Controlla oggi promemoria e calendario e indicami conflitti"
```

Lo scheduler e `yano local-pc ask` inviano al planner persistente `planner-01`
nel runtime logico `yano-local-pc`; non viene mai usato lo scope di un progetto
applicativo.
Operazioni che modificano o inviano dati richiedono conferma esplicita.

`yano-local-pc` è anche il destinatario obbligatorio degli incidenti del
control-plane rilevati dai planner dei progetti. Riceve evidenze concise
(progetto/root, run o ticket, fase, errore e classificazione bloccante),
informa l'utente e non modifica automaticamente il codice o i flussi di Yano.
Un planner applicativo può continuare solo se l'incidente non è bloccante;
se è bloccante conserva il checkpoint e sospende le deleghe dipendenti.

Il cron globale chiude inoltre le sessioni terminali dei worker on-demand
`architect` e `auto-improver` dopo la fine del loro lavoro, lasciando intatti
planner e worker ancora attivi.

Nel widget bottom dell'interfaccia Pi/Herdr, Yano mostra a destra il semaforo
MQTT e, sotto, le operazioni attive in tempo reale (`CLI`, `MCP`, `AGENT` e
playbook). Ogni voce scompare quando la chiamata termina.
