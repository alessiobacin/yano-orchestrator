Type: human
Kind: grilling
Status: resolved
Blocked by: 11, 16

## Question

Quale contratto implementa le probe bounded e l'installazione da manifest per skill, CLI, MCP e credenziali? Definire registry/lockfile, version resolution, comandi consentiti, timeout, sandbox, redaction, rollback, cache e output delle capability card.

## Answer

La fonte autorizzata è un manifest/lockfile versionato con ID capability, versione, checksum, origine, scope e comando/probe. `roles.yaml` riferisce gli ID e non installa direttamente.

Le installazioni sono limitate a skill vendorizzate o artifact approvati, CLI da registry/package manager con versioni lockate, MCP da configurazioni package/HTTP approvate e credenziali da secret reference sicuri.

Le probe usano processi diretti senza shell, timeout bounded, exit policy esplicita, output redatto e sandbox/working directory controllata. Per MCP eseguono handshake, `tools/list` e verifica di schema, trasporto e autorizzazione.

Se installazione o probe fallisce, il runtime fa rollback delle installazioni nuove, invalida la cache, marca la capability `blocked` e produce istruzioni manuali. Ogni risultato produce una capability card con versione reale, evidenza, scope, permessi, fingerprint dell'ambiente e timestamp.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
