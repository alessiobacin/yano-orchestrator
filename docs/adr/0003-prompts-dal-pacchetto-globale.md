# ADR-0003: Prompt dei ruoli letti sempre dall'installazione globale

- **Stato**: accettata (sostituisce il design precedente di `yano sync-prompts`)
- **Data**: 2026-09-02 (prassi corrente, Revisione 47 in `bin/yano.mjs`)
- **File di riferimento**: `README.md` (sezione "Role prompts"), `bin/yano.mjs` (intestazione, Revisione 47), `docs/cheat-sheet/07-copy-prompts.md`, `extensions/orchestrator.ts`

## Contesto

Un aggiornamento di Yano deve propagarsi a tutti i progetti esistenti senza
passi aggiuntivi. Il design iniziale copiava `prompts/` dentro ogni progetto
all'init e richiedeva una risincronizzazione dopo ogni `yano update` (comando
`yano sync-prompts`, oggi rimosso): la copia locale poteva diventare stale e
il progetto continuava a usare prompt vecchi. Il README documenta il fallimento
del vecchio approccio e il comando non esiste più.

## Decisione

- **Default: nessuna copia per progetto.** I prompt dei ruoli sono letti
  sempre live `<installed-package>/prompts/<role>.md` dall'installazione
  globale che `pi` ha effettivamente caricato. `yano init` non crea più la
  cartella `prompts/` nei progetti scaffoldati; `yano update` da solo basta
  a portare tutti i progetti alla versione corrente.
- **Override esplicito e per-file**: chi vuole personalizzare il prompt di un
  ruolo per UN progetto esegue `yano copy-prompts` dalla root del progetto
  (copia i prompt correnti in
  `.pi/extensions/yano-orchestrator/prompts/`, con backup
  `prompts.bak-<timestamp>`) e avvia le istanze con
  `yano start ... --custom-prompts`. L'override è per-file: un ruolo mai
  personalizzato viene sempre letto fresco dall'installazione globale, anche
  con `--custom-prompts` attivo; se la cartella locale non esiste,
  `--custom-prompts` è un no-op sicuro.
- **Niente sincronizzazione automatica**: non esiste più `yano sync-prompts`;
  la risoluzione del drift è strutturale (default globale) invece che un passo
  di resync dopo ogni update.

## Conseguenze

- Aggiornamenti globali efficaci immediatamente per tutti i progetti, senza
  intervento manuale.
- La personalizzazione locale è un'azione esplicita e isolata per progetto,
  con backup automatico e override granulare per ruolo: personalizzare un
  ruolo non può congelare per errore i prompt di tutti gli altri.
- Restano da gestire i progetti scaffoldati prima della modifica (cartella
  `extensions/` o `prompts/` residue): `yano start` le ignora e usa
  l'estensione globale, segnalandolo con una nota; la cartella residua è
  inerte e rimovibile.