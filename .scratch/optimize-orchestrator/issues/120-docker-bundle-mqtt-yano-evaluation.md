Type: human
Kind: task
Status: claimed

## Question

L'utente propone di installare Yano in un container Docker per risolvere
l'avvio cross-platform, con MQTT e Yano nello stesso container e la CLI `yano`
installata localmente sull'host (fuori dal container). Chiede anche, in ogni
caso, il riavvio deterministico del daemon Docker quando è giù.

Da valutare prima di implementare:

- Yano orchestra processi `pi` dentro pane Herdr sull'host, fa `git
  worktree`, apre editor/terminali, e legge/scrive file di progetto
  nell'albero di lavoro dell'utente — tutte operazioni che presuppongono
  esecuzione **sull'host**, non in un container isolato. Mettere "Yano" (il
  processo orchestratore) dentro un container lo isolerebbe proprio dalle
  risorse che deve orchestrare (Herdr, worktree Git, filesystem di progetto),
  a meno di bind-mount pervasivi e passthrough del socket Herdr — complessità
  che rischia di introdurre più problemi cross-platform di quanti ne risolva.
  Il broker MQTT invece è già distribuito in Docker (`mqtt/compose.yaml`,
  usato anche da `runDoctor({ autoStartBroker })`) proprio perché è uno
  servizio stateless senza queste dipendenze sull'host.
- Il riavvio deterministico del daemon Docker è invece un miglioramento valido
  indipendentemente dalla decisione sul bundling: oggi `yano doctor` rileva
  "Docker è installato ma il daemon non sembra in esecuzione" e si ferma lì,
  senza tentare di riavviarlo (verificato dal vivo in questa sessione,
  `yano doctor --json` in ambiente senza dockerd attivo). Questo è un caso
  particolare del registro `yano services` (#117): il daemon Docker stesso è
  un servizio esterno di cui Yano dipende (per il broker MQTT auto-avviato) e
  di cui oggi non tenta mai il restart.

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
