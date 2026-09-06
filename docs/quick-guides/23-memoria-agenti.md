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

Ogni volta che un tool fallisce durante il turno, la memoria di ruolo registra
`[TENTATIVO FALLITO] <tool>: <errore>`. Se lo stesso tool fallisce di nuovo con
lo stesso identico errore in un turno successivo, la voce diventa
`[RIPETUTO — NON RIPROVARE COSÌ]`: è il segnale esplicito che quell'approccio
è già stato tentato e non ha funzionato, così l'istanza corrente (o quella che
la sostituisce dopo un kill/restart) non lo ripete alla cieca. L'estrazione è
puramente deterministica (confronto di stringhe sull'errore già registrato,
nessuna chiamata a un modello) — costo aggiuntivo nullo rispetto
all'aggiornamento di memoria già eseguito ad ogni turno.

All’avvio di ogni round Yano carica solo una finestra limitata della memoria
rilevante, così il contesto non cresce indefinitamente. Prima di una scelta
tecnica, operativa o non banale, l’agente deve verificare la memoria e chiedere
se l’utente vuole ripetere l’approccio precedente oppure adottarne uno diverso.
Non serve conferma per comandi meccanici già autorizzati.

## Ordine di lettura per risparmiare contesto

Ogni agente riceve dal runtime una regola comune: prima deve leggere memoria
progetto, memoria del ruolo/istanza, diagrammi e documenti pertinenti, task e
report. Se queste informazioni sono sufficienti, legge solo i file coinvolti
dal task. Approfondisce progressivamente import, dipendenze, configurazioni e
test solo quando sono necessari.

Memoria e documentazione non sostituiscono la verifica: informazioni critiche
o potenzialmente obsolete devono essere confrontate con il codice reale, i
test e il runtime. Nel report l’agente indica documenti, file, approfondimenti,
lacune e verifiche eseguite.
