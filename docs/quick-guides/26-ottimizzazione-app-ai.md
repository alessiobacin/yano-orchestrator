# Ottimizzazione di applicazioni AI

Il playbook `ai-application-optimization` è dedicato ai progetti che usano
LLM, agenti, retrieval, embedding o tool AI. È distinto da
`auto-improvement-360`: quest’ultimo esegue un audit generale; il nuovo flusso
misura in profondità contesto, token, granularità, routing, latenza,
affidabilità, qualità e costi.

```bash
yano architect assess --project-root "$PWD" \
  --task "ottimizza token, contesto, routing LLM e costi" --json
yano start --instance ai-optimizer-01 --role ai-optimizer --project "$PWD"
```

Il ruolo legge prima memoria progetto, documenti collegati e orientamento Code
Mem. Poi produce una baseline riproducibile e procede in ordine: inventario AI,
contesto, granularità, modelli, runtime, qualità e remediation. Ogni parere ha
score e confidence su 10 e ogni fatto ha una fonte o un limite esplicito.

Non si accettano riduzioni di token o costo se peggiorano qualità o affidabilità
senza conferma esplicita. Provider, dipendenze, budget e produzione richiedono
un gate del planner/utente. Dopo una modifica si ripetono benchmark e workflow
influenzati e si aggiorna la documentazione applicabile.
