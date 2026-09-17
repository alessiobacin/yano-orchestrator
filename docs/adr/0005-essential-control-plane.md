# 0005 — Supervisione deterministica e interfacce applicative

Decisione confermata dall’utente il 2026-09-15: mantenere e migliorare Gantt,
rimuovere Kanban bug/suggestions conservando API e dati, ridurre codice e
sessioni LLM permanenti applicando ponytail.

La funzione lifecycle condivisa governa cleanup e spiegazione dello stato;
i reviewer sono protetti dai loro assignment, anche senza ticket proprio.
Il cron comune include scheduling; la chat scheduler non è un prerequisito.
Local PC resta persistente. I nomi tecnici Herdr e le istanze di progetto
restano distinti; fingerprint distingue installazioni con stessa versione.

La compatibilità conserva `dash`, database e adapter Agentation opzionali.
Il browser adapter usa DOM e screenshot: introspezione framework-specifica
non garantita. Tempi futuri non dichiarati non vengono inventati nel Gantt.

Rollback: ripristino del codice precedente; nessuna migrazione distruttiva
del database. Le GUI applicative devono usare gli endpoint esistenti.

Ponytail full è il default per tutti i ruoli/progetti, con opt-out persistente
globale o per progetto. L’iniezione a ogni turno copre anche i prompt custom.
