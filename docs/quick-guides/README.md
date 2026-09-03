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
13. [Deployment agent](./13-deployment-agent.md)
14. [Auto-improve periodico](./14-auto-improve.md)
15. [Memoria persistente degli agenti](./23-memoria-agenti.md)
16. [Yano Architect: playbook e agenti on-the-fly](./16-yano-architect.md)
17. [Ripristino automatico di un progetto](./17-ripristino-automatico.md)
18. [Catalogo playbook: requisiti, bundle e rimozione](./18-catalogo-playbook.md)
19. [Inventario agenti, repair e Gantt](./19-inventario-agenti-e-gantt.md)
20. [Sales Companion: riprendere i 17 documenti](./20-sales-companion-17-documenti.md)
21. [CLI semantica per gli agenti Pi](./21-yano-cli-semantica.md)
22. [Job ricorrenti e Yano Scheduler](./22-job-ricorrenti.md)
23. [Bootstrap documentale del progetto](./24-bootstrap-documentale-progetto.md)

Per i riferimenti completi dei comandi (oltre alle controparti compatte qui
sopra) vedi anche [quick-start](./quick-start.md), [yano-feedback](./12-yano-feedback.md),
[yano-auto-improve](./yano-auto-improve.md),
[memoria agenti](./23-memoria-agenti.md),
[yano-model-advisor](./yano-model-advisor.md), [yano-architect](./yano-architect.md),
[yano-trace](./yano-trace.md), [yano-deployment](./yano-deployment.md),
[yano-recovery](./yano-recovery.md) e [yano-local-pc](./yano-local-pc.md).

Per una spiegazione completa del primo task, consulta anche la
[quick start estesa](./quick-start.md). Per il comportamento dettagliato del
reload controllato, consulta [yano-recovery](./yano-recovery.md).
Per trovare il comando minimo per ogni operazione, consulta la raccolta
[`cheat-sheet`](../cheat-sheet/README.md). La policy per aggiornare sempre i
documenti insieme al codice è in
[`documentation-sync.md`](../guides/documentation-sync.md).

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
- 'yano repair --yes' riallinea agenti, scope MQTT e Planner quando il progetto
  è in uno stato incoerente; aggiungi '--update' per aggiornare anche Yano.
- Gli agenti ricevono la skill condivisa `yano-cli`: per richieste come
  "il watcher è attivo?" o "inizializza questa repository" usano i comandi
  documentati e preferiscono l'output `--json` per le verifiche.
