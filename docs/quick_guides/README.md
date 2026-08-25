# Yano: quick guides

Questa cartella raccoglie procedure brevi per le operazioni più comuni. Sono
pensate per chi usa Yano per la prima volta e lavora dalla root del progetto.

## Percorso consigliato

1. [Installazione e prerequisiti](./01-installazione-e-prerequisiti.md)
2. [Nuovo progetto: avvio manuale](./02-nuovo-progetto-avvio-manuale.md)
3. [Nuovo progetto: Herdr e planner automatici](./03-nuovo-progetto-con-herdr.md)
4. [Inizializzare una repository esistente](./04-inizializzare-repository-esistente.md)
5. [Avviare planner e altri agenti](./05-avviare-agenti.md)
6. [Aggiornare Yano](./06-aggiornare-yano.md)
7. [Mettere in pausa e riprendere un task](./07-pausa-e-ripresa.md)
8. [Attivare e analizzare il trace](./08-trace-e-diagnosi.md)
9. [Problemi comuni](./09-troubleshooting.md)
10. [Watcher: ticket per falle di Yano](./10-watcher-falle-yano.md)
11. [Configurazione globale](./11-configurazione-globale.md)
12. [Yano Debugger](./12-yano-debugger.md)
13. [Deployment agent](./13-deployment-agent.md)
14. [Auto-improve periodico](./14-auto-improve.md)
15. [Yano suggester](./15-yano-suggester.md)

Per una spiegazione completa del primo task, consulta anche la
[quick start estesa](../quick-start.md). Per il comportamento dettagliato del
reload controllato, consulta [yano-recovery](../yano-recovery.md).

## Regole rapide

- Esegui i comandi dalla root del progetto.
- Usa 'yano start', non 'pi' lanciato manualmente, per caricare correttamente
  skill, trace e configurazione di ruolo.
- Tutti gli agenti che devono collaborare devono usare lo stesso scope
  '--project', oppure devono ometterlo tutti e lasciare che Yano lo derivi
  dalla root.
- 'yano end' chiude un run; 'yano pause' lo sospende senza chiuderlo.
- 'yano update' non riavvia i processi attivi; usa 'yano update --reload --yes'
  quando vuoi applicare il nuovo codice alle istanze già aperte.
