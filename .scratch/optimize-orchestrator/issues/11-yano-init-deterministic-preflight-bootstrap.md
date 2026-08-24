Type: human
Kind: grilling
Status: resolved

## Question

Come deve comportarsi `yano init` quando skill, CLI, MCP, credenziali, broker, runtime o altri prerequisiti dichiarati dal progetto/ruolo non sono presenti? Definire ordine e completezza del preflight, richiesta interattiva dei secret solo quando necessari, comportamento non-interactive, installazione deterministica e idempotente delle dipendenze mancanti, versioni/lockfile, permessi, retry bounded, evidenze e condizioni di abort senza stato parzialmente configurato.

## Answer

`yano init` esegue il preflight nell'ordine: configurazione → runtime Node/Git/Pi → broker MQTT → skill → CLI → MCP → credenziali → ruoli/Playbook.

I secret vengono richiesti solo se necessari per i ruoli o Playbook selezionati. Non vengono mostrati né salvati in chiaro. In modalità non-interactive, un secret mancante causa un errore esplicito con istruzioni per la configurazione manuale.

Le installazioni automatiche usano esclusivamente dipendenze dichiarate in manifest approvati e versionati, mai nomi arbitrari presi direttamente da `roles.yaml`. Le skill vengono risolte nel pacchetto/cache locale, le CLI nello scope deterministico previsto dal manifest e gli MCP nella configurazione di progetto.

Il bootstrap è idempotente e ripetibile. Se un'installazione o verifica fallisce, `yano init` informa quale prerequisito è fallito, come risolverlo manualmente, esegue il rollback delle modifiche applicate e non lascia il progetto in uno stato parzialmente configurato.

Il preflight viene rieseguito a ogni `yano start` e prima di ogni dispatch di ruolo; il runtime non si fida di una verifica precedente se ambiente, manifest o capability possono essere cambiati.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
