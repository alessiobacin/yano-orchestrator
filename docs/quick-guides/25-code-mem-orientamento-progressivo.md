# Code Mem e orientamento progressivo

Ogni progetto Yano inizializzato dispone di Code Mem. Prima di leggere il
codice in profondità, l’agente usa questa sequenza:

1. `.pi/extensions/yano-orchestrator/memory/project.md` e documenti essenziali;
2. `cm recall` a livello sintetico per memoria semantica;
3. `cm query` per individuare file, moduli, simboli e relazioni nel grafo;
4. lettura mirata dei file pertinenti;
5. approfondimento progressivo solo quando una dipendenza o una verifica lo
   richiede.

Il runtime inietta automaticamente un orientation pack bounded per ogni turno:

```bash
cm recall "<task>" --level 1 --limit 6 --mode hybrid
cm query "<domanda architetturale o di dipendenza>"
```

Il pack è limitato a 6.000 caratteri. Code Mem serve a restringere il perimetro,
non sostituisce la verifica nel codice, nei test o nel comportamento runtime.
`cm scan --deep` è un’operazione di indicizzazione da eseguire durante
l’inizializzazione o un refresh esplicito, non a ogni turno dell’LLM.

Se `cm` non è disponibile o restituisce un errore, l’agente continua usando
project memory, documentazione e flusso Yano: Code Mem è best-effort e non può
impedire l’avvio di un agente.
