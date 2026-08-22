# 74 — Specifica delle issue runtime mancanti

Type: task  
Status: resolved  
Blocked by: 04, 08, 09, 14, 15, 16, 20, 21, 23, 25, 26

## Question

Quali issue mancano per completare l'enforcement runtime deterministico oltre
il vertical slice Playbook già implementato?

## Resolution

Pubblicata [spec-missing-issues.md](../spec-missing-issues.md), con 28 user
story e otto aree: reconciliation, capability cards, dispatcher effetti,
approval multi-utente, recovery, finalize evidence, retention/benchmark e
governance meta-operativa.

La specifica conserva i seam SQLite/MQTT/CLI/tarball e definisce i test
black-box per ogni area. Non è stato applicato `ready-for-agent`: il tracker
locale dichiara la triage non applicabile e non fornisce un vocabolario di
label operativo.
