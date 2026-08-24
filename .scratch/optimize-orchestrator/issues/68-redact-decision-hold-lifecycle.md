Type: human
Kind: task
Status: resolved
Blocked by: 26, 65, 67

## Question

Impedire che le risposte dei tool di creazione o risoluzione hold ristampino dati sensibili.

## Acceptance Criteria

- `decision_hold_create` redige context e metadata nella risposta.
- `decision_hold_answer` redige resolution metadata nella risposta.
- `decision_hold_cancel` redige context e metadata nella risposta.
- Lo storage interno resta completo e le operazioni persistenti non cambiano.

## Resolution

Applicata la redazione runtime alle risposte di tutti i tool lifecycle hold; aggiunto test di creazione con secret annidati.
