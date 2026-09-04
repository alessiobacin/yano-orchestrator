# Local PC

`yano-local-pc` è il servizio logico globale persistente nel workspace Herdr
`yano-local-pc`. L’unico processo LLM persistente del control plane è il suo
`planner-01`: il servizio non avvia un secondo agente Pi usa-e-getta. Watcher,
feedback e scheduler verificano e ripristinano sempre quel planner.

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

Nel widget bottom dell'interfaccia Pi/Herdr, Yano mostra a destra il semaforo
MQTT e, sotto, le operazioni attive in tempo reale (`CLI`, `MCP`, `AGENT` e
playbook). Ogni voce scompare quando la chiamata termina.
