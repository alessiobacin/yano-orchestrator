Type: research
Status: resolved

## Question

Quale procedura e quali fonti devono usare l'agente di ricerca capability e il runtime per determinare, per un nuovo ruolo, skill, CLI, MCP, credenziali e capability realmente disponibili e verificabili? Definire output, prove di caricabilità, conflitti, versioni, permessi e condizioni per rifiutare una configurazione solo nominale in `roles.yaml`.

## Answer

Il report [Research 08 — Verifica delle capability per nuovi ruoli](../research/08-capability-verification.md) definisce fonti, probe bounded e invarianti. La decisione è: i valori in `roles.yaml` sono dichiarazioni, non prove; ogni skill, CLI, MCP e credenziale deve avere evidenza di risoluzione, caricabilità, versione/scope e autorizzazione. Configurazioni non verificabili, con secret hardcoded, scope MCP non isolabile o capability nominali devono essere rifiutate o portare il run in `blocked`/`needs_replan`. Il report documenta anche il gap attuale tra `--role` e `agents.yaml`.
