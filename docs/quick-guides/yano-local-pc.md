# Local PC

`yano-local-pc` è un servizio globale persistente nel workspace Herdr
`yano-local-pc`. È gestito dal self-heal di Yano insieme a watcher,
feedback e scheduler e viene ricreato se la tab o il processo vengono chiusi.

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

Lo scheduler chiama l'istanza esatta `yano-local-pc` tramite `agent_send`.
Le richieste dell'utente dalla CLI usano lo stesso scope globale
`yano-scheduler`; non viene mai usato lo scope di un progetto applicativo.
Operazioni che modificano o inviano dati richiedono conferma esplicita.

Nel widget bottom dell'interfaccia Pi/Herdr, Yano mostra a destra il semaforo
MQTT e, sotto, le operazioni attive in tempo reale (`CLI`, `MCP`, `AGENT` e
playbook). Ogni voce scompare quando la chiamata termina.
