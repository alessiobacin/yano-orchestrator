# Audit confidence contract

Ogni relazione, capitolo, finding, raccomandazione e ipotesi deve riportare
due dimensioni indipendenti di confidenza. Non sono una misura dei token, non
sono chain-of-thought e non sostituiscono le evidenze.

```yaml
confidence: 0-10                 # alias retrocompatibile di evidence_confidence
evidence_confidence: 0-10        # quanto l'evidenza è diretta, completa e riproducibile
judgment_confidence: 0-10        # quanto l'LLM ritiene solido il proprio giudizio
judgment_confidence_rationale: "..."
```

`confidence` e `evidence_confidence` devono avere lo stesso valore quando
compaiono insieme. `judgment_confidence` è un'autovalutazione del risultato,
non una dichiarazione di certezza assoluta: deve diminuire quando mancano
prove, esistono contraddizioni, il comportamento è ambiguo o la verifica è
bloccata. La motivazione deve essere breve, osservabile e citare il principale
limite; non deve ricostruire il ragionamento privato del modello.

Scala comune:

- `0`: nessuna base verificabile / `UNKNOWN`;
- `1-3`: indicazione debole, evidenza parziale o forte ambiguità;
- `4-6`: giudizio plausibile ma con lacune o dipendenze non verificate;
- `7-8`: evidenza buona e interpretazione sufficientemente stabile;
- `9-10`: prova diretta e riproducibile, senza contraddizioni rilevanti.

Un fatto può avere `evidence_confidence: 9` e `judgment_confidence: 6` se
l'osservazione è certa ma la sua interpretazione o priorità è discutibile. Un
giudizio `10` richiede una verifica diretta e non solo l'assenza di errori.
Quando un dato non è misurabile, usare `0` e `UNKNOWN` con il limite esplicito;
non trasformare l'incertezza in un voto implicito.
