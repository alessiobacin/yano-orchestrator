# Sviluppare un nuovo comando Yano end-to-end

Guida operativa per aggiungere un sottocomando alla CLI `yano` seguendo il
contratto documentale del repository. Ricavata dall'implementazione reale dei
comandi esistenti (in particolare `yano gantt` e `yano cron`): ogni passo cita
i file in cui il pattern è già applicato, così la guida descrive la prassi
verificata invece di un flusso inventato.

## 1. Dove vive un comando

`bin/yano.mjs` è il punto di ingresso unico (`package.json` → campo `bin`, vedi
l'intestazione del file). Ogni sottocomando delega a un modulo sotto `scripts/`:

- `yano init` → `scripts/create-project.mjs` (`runCreateProject`)
- `yano gantt` → `scripts/gantt-server.mjs` (`runGantt`), importato da
  `bin/yano.mjs:73` e invocato nel dispatch alle righe ~246
- `yano doctor` → `scripts/doctor.mjs` (`runDoctor`)

Regola: `bin/yano.mjs` non implementa la logica, dispaccia soltanto. La logica
sta in `scripts/<modulo>.mjs`, che esporta `run<Comando>()` e riceve
`{ cwd, argv, packageRoot }` come `yano gantt` (vedi `runGantt` in
`scripts/gantt-server.mjs`).

## 2. Il contratto documentale (obbligatorio)

La politica di sincronizzazione è in `docs/guides/documentation-sync.md`; la matrice
obbligatoria impone che una modifica CLI aggiorni:

| Superficie | File |
| --- | --- |
| Normativa | `README.md`, `docs/quick-guides/quick-start.md`, `docs/architecture/architecture.md` se cambia stato/routing/persistenza |
| Operativa | quick guide pertinente (nuova voce in `docs/quick-guides/` + indice in `README.md` del raccoglitore) |
| Cheat-sheet | voce breve in `docs/cheat-sheet/` (es. `31-scheduler.md`) + link nell'indice `docs/cheat-sheet/README.md` |
| Skill CLI | `skills-vendor/yano/yano-cli/SKILL.md` + `skills-vendor/yano/yano-cli/references/command-reference.md` |
| Diagramma | `docs/architecture/architecture.mmd` e/o `docs/diagram/` se cambia un flusso o una relazione |

`scripts/check-documentation-sync.mjs` verifica deterministicamente le
superfici fondamentali e la lista di comandi in `command-reference.md`: un
comando nuovo che non compare nella reference fa fallire `npm run check:docs`.

## 3. Test

- Ogni comportamento va coperto da uno smoke test `scripts/smoke-test-<area>.mjs`
  (la suite è `npm test` → `scripts/test-all.mjs`, che esegue syntax check,
  check:docs, lint capability/playbook, skill isolation, tutti gli smoke test
  e l'e2e full flow).
- Per l'ambiente: `scripts/setup-dev-stubs.mjs` ricrea gli stub di test;
  `scripts/test-all.mjs` avvia il broker MQTT da `mqtt/compose.yaml` se
  necessario (porte 1883) e lo ferma a fine corsa.
- Prima del commit: `npm run check:docs` e, in locale con diff obbligatorio,
  `YANO_DOCS_ENFORCE_DIFF=1 npm run check:docs` (fallisce se una modifica al
  codice non è accompagnata da aggiornamenti documentali).

## 4. Esempio reale ripetibile: aggiungere un flag a un comando esistente

Pattern già applicato a `yano gantt` (vedi `scripts/gantt-server.mjs`):

```bash
# 1. implementare il flag nel modulo scripts/
#    (es. GANTT_PORT_MIN 10000 / GANTT_PORT_MAX 19999, --persistent, --link,
#     --links — helpers reali già presenti)
# 2. aggiornare la matrice documentale (sezione 2)
# 3. aggiornare lo smoke test dedicato (scripts/smoke-test-gantt.mjs)
# 4. verificare i contratti
npm run check:docs
npm test
```

Esempi di flag con registro persistente nel data-root globale: `--persistent`
registra il link Gantt, `--link` lo recupera e `--links` elenca tutte le
registrazioni (contratto documentato in `docs/guides/documentation-sync.md`, sezione
"Contratto Gantt corrente").

## 5. Checklist di chiusura

- [ ] `bin/yano.mjs` espone il sottocomando e delega a `scripts/`
- [ ] `README.md` + `docs/quick-guides/quick-start.md` coprono il comando
- [ ] `docs/quick-guides/` contiene la procedura breve e il README del raccoglitore la linka
- [ ] `docs/cheat-sheet/` contiene la voce rapida e l'indice la linka
- [ ] `skills-vendor/yano/yano-cli/references/command-reference.md` elenca il comando
- [ ] `skills-vendor/yano/yano-cli/SKILL.md` spiega come gli agenti lo usano
- [ ] `docs/architecture/architecture.mmd`/`docs/diagram/` aggiornati se cambia un flusso
- [ ] `npm run check:docs` passa; `npm test` passa (o motivo esplicito se la suite e2e richiede infrastruttura assente)