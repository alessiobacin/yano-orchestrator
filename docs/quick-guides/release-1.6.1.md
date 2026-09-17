# Yano 1.6.1

Correzione del reload verificata sul runtime Herdr reale dopo la release 1.6.0.

- Il reload passa automaticamente la motivazione richiesta dalla ripresa.
- Una presenza MQTT trattenuta con stato `offline` non impedisce il rilancio.
- Il database feedback usa WAL e attesa limitata dei lock: import, API e
  planner possono accedere contemporaneamente senza fallimenti immediati.
- Un lancio fallito impedisce di registrare il checkpoint come ripreso.

Verifica operativa prima del bump: pausa e snapshot di planner/coder,
rilancio di entrambi e handshake della versione eseguita. Coperti anche
motivo personalizzato/vuoto e filtro delle presenze offline nei test di
regressione. La suite completa è passata prima del bump: 154 controlli, inclusi
1.095 test unitari e 51 asserzioni E2E. Passati separatamente il nuovo
test di concorrenza e le regressioni API/CLI/HTTP dopo la modifica SQLite.

Include tutte le modifiche della [1.6.0](release-1.6.0.md).

Import operativo newMioDOC dopo la correzione: 14 creati, 46 già presenti,
zero errori; scheduler `completed`. llmProxy ricollegato al container reale;
MQTT, llmProxy e API feedback verificati sani.
