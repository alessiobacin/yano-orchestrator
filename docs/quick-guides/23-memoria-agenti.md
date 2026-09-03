# Memoria persistente degli agenti

Ogni agente Yano aggiorna la memoria alla fine di ogni round dell’LLM. La
memoria non dipende dalla tab Herdr o dal processo: se un agente viene killato,
il successivo agente dello stesso ruolo può recuperare decisioni e fatti già
registrati.

Per un progetto i file sono sotto `.pi/extensions/yano-orchestrator/memory/`:

```text
memory/
├── roles/<role>.md          # condivisa tra istanze dello stesso ruolo
├── instances/<instance>.md  # diagnostica della singola istanza
└── user-preferences.md      # preferenze esplicite dell’utente
```

La memoria del ruolo è limitata a 12.000 caratteri, quella delle preferenze a
8.000 e quella diagnostica dell’istanza a 4.000. Quando il limite viene
superato, Yano conserva la parte più recente. I file sono esclusi da Git e non
devono contenere segreti, token o credenziali.

All’avvio di ogni round Yano carica solo una finestra limitata della memoria
rilevante, così il contesto non cresce indefinitamente. Prima di una scelta
tecnica, operativa o non banale, l’agente deve verificare la memoria e chiedere
se l’utente vuole ripetere l’approccio precedente oppure adottarne uno diverso.
Non serve conferma per comandi meccanici già autorizzati.
