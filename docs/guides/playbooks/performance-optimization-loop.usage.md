# Playbook: performance-optimization-loop

Usa questo playbook per qualunque progetto quando l'obiettivo è ridurre
latenza, token, contesto o costo mantenendo invariati qualità, correttezza,
affidabilità e sicurezza. Non è un audit specifico di Yano e non esegue
schedule da solo.

## Preparazione

Il planner chiede conferma dei parametri: benchmark, quality oracle, almeno 3
ripetizioni, soglia di promozione (default 3%), intervallo plateau (default
1–3%), 3 round consecutivi di plateau, soglia stagnazione (default <=1%), 5
round consecutivi di stagnazione e costo massimo +2%.

Il checkout originale resta immutabile. Il planner crea worktree distinti per
baseline originale, baseline corrente e candidate. Il candidate è l'unico
modificabile e nessuna modifica arriva automaticamente nel progetto principale,
in produzione o nell'installazione globale.

## Round

Ogni round misura almeno tre volte baseline e candidate con la stessa suite,
modello, parametri, rete, cache e dataset. Registra latenza end-to-end e per
fase, chiamate LLM, token input/output, dimensione del contesto, tempi tool e
attese, costo, qualità, errori, retry e timeout.

Si sceglie una sola ipotesi basata sui dati. Sono candidati possibili modelli
più veloci, parallelismo sicuro, sub-agent verificati, prompt e contesto più
brevi, retrieval mirato, caching, eliminazione di codice o passaggi ridondanti
e routing meno costoso. Prima di installare plugin o dipendenze si verifica che
esista una soluzione affidabile già pronta.

Il coder modifica il candidate, reviewer e QA verificano il risultato, poi
`speed-benchmarker` ripete l'intera suite. Un dato non misurabile è `unknown`, mai una
stima inventata. Ogni opinione ha score e confidence su 10.

## Promozione

- `>=3%`: promozione immediata a baseline corrente;
- `>1%` e `<3%`: si ritenta per tre round; dopo il terzo, l'ultimo candidate
  diventa baseline;
- `<=1%`: dopo cinque round consecutivi, l'ultimo miglioramento diventa
  baseline finale e il loop termina.

Ogni promozione richiede qualità non peggiorata, costo entro il 2% e test
applicabili superati. Ogni round produce un report in
`docs/reports/performance-optimization-DD-MM-HH_MM.md`, con modifica esatta,
benchmark prima/dopo e decisione. Lo stato dei contatori e dei worktree viene
persistito per il resume.
