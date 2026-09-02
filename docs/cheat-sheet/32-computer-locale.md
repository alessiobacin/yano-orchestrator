# Computer locale

Servizio globale persistente con MCP Apple, separato dai progetti:

```sh
yano computer start
yano computer status
yano computer ask --prompt "Cosa ho in calendario oggi?"
```

Il self-heal globale ricrea workspace e tab `Computer locale` dopo una
chiusura o un riavvio. La chiave AssemblyAI per Voice Memos va salvata nella
configurazione globale con il nome `YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY`.
