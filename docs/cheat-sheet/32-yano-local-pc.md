# Local PC

Servizio globale persistente con MCP Apple, separato dai progetti:

Se configurate, il supervisore aggiunge automaticamente `apple-voice-memos`
usando `YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY` ed `evolution-api` usando
`EVOLUTION_API_URL`/`EVOLUTION_API_KEY` dalla configurazione globale.
Per MCP aggiuntivi usare `yano mcp agent add --agent yano-local-pc ...`.

```sh
yano local-pc start
yano local-pc status
yano local-pc ask --prompt "Cosa ho in calendario oggi?"
```

Il self-heal globale ricrea workspace e tab `Local PC` dopo una
chiusura o un riavvio. La chiave AssemblyAI per Voice Memos va salvata nella
configurazione globale con il nome `YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY`.
