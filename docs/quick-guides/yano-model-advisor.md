# Yano Model Advisor

`yano model-advisor` propone un pin llmProxy **pinnato** nel formato
`model@provider-id` per una
role-class (`coordinator` o `support`), scegliendolo tra il catalogo live di
llmProxy — l'istanza locale di [llmProxy](../../llmProxy) che Alessio gira
via Docker, di norma su `http://127.0.0.1:7045` — in base a costo, punteggio
di coding e latenza reali del momento, invece di una alias fissa
(`reasoning-model`/`coding-model`) scelta una volta per tutte.

Questo incremento è solo **libreria + CLI**: non c'è un server REST (a
differenza di `yano feedback`/`yano auto-improve`/`yano feedback`), perché
una singola lookup non richiede nulla di persistente. Il planner legge il
suggerimento, lo presenta con il roster e lo usa solo dopo la conferma
dell'utente; se il modello pinnato smette di essere disponibile a metà round
usa il fallback `llmproxy` (auto-routing) e lo dichiara nel report.

## Perché

Fino a questo incremento ogni ruolo in `agents/roles.yaml` dichiarava un
`model` fisso:

```yaml
model:
  provider: llmproxy
  model: reasoning-model   # o coding-model
```

Ora ogni ruolo parte da un default neutro:

```yaml
model:
  provider: llmproxy
  model: llmproxy   # routing dinamico di llmProxy — "auto" finché nessuno pinna altro
```

`model-advisor` è lo strumento che permette al planner (in un incremento
successivo) di **sostituire** quel default con un pin concreto per il task
corrente, quando i dati live di llmProxy indicano un'opzione chiaramente
migliore — e di tornare ad "auto" quando i dati non sono disponibili o
affidabili.

## Come decide

1. Recupera il catalogo provider di llmProxy: prova `GET
   {YANO_LLMPROXY_URL}/api/providers`, e se fallisce (rete, timeout, risposta
   non riconosciuta) esegue in locale `llmproxy provider:list` e ne
   analizza l'output testuale — le due strade producono la stessa forma
   normalizzata di provider (vedi nota tecnica più sotto).
2. Scarta i provider non disponibili (bench in errore, es. `meta` nel
   catalogo di esempio) e — se `--vision` è richiesto — quelli senza
   supporto immagini.
3. Calcola un prezzo "blended" USD/1M token per provider (`(in + out) / 2`) e
   trova il più economico disponibile (`cheapest`).
4. Definisce la **fascia economica**: tutto ciò che costa fino a
   `AFFORDABLE_BAND_MULTIPLIER` (default **3**, costante nominata e commentata
   in `scripts/yano-model-advisor.mjs`, regolabile) volte `cheapest` conta
   come "quasi economico allo stesso modo".
5. Per `coordinator` (ruoli ad alto impatto: coder, reviewer, planner quando
   elevato, futuro moderatore di debate): tra i provider nella fascia
   economica, vince il punteggio `coding` più alto — l'intelligenza migliore
   tra chi costa quasi uguale al più economico.
6. Per `support` (ruoli di utilità/basso impatto): tra i provider nella
   fascia economica che superano `SUPPORT_MIN_CODING_FLOOR` (default **60**,
   anch'essa nominata/regolabile), vince il prezzo più basso — il più
   economico che è comunque abbastanza bravo.
7. Se il catalogo non è raggiungibile, o non ha candidati idonei, la
   raccomandazione è sempre e comunque **`llmproxy` (auto)** — mai un
   crash, mai un pin su dati inesistenti.

## Esempio verificato (dati reali dalla macchina di Alessio)

| provider | coding | prezzo in/out USD/1M | blended | nella fascia economica (≤3× 0.095)? |
|---|---|---|---|---|
| opencode-bacin / opencode-alessio | 69.1 | 0.03 / 0.16 (da `best=`, `price=` è n/a) | **0.095** (il più economico) | sì |
| **openrouter-glm** | **71.5** | 0.07 / 0.25 | 0.16 | sì |
| openrouter-openai | 71.4 | 0.20 / 1.20 | 0.70 | sì |
| qwen-vision | 55.9 | 0.40 / 1.60 | 1.00 | no |
| qwen | 66.0 | 2.50 / 7.50 | 5.00 | no |
| kimi | **76.2** (il più alto in assoluto) | 3.00 / 15.00 | 9.00 | no |
| meta | n/a | n/a | — | non disponibile (bench in errore) |

- **coordinator** → `z-ai/glm-5.3-flash@openrouter-glm` — batte
  opencode-bacin/alessio (coding 69.1 contro 71.5, a un prezzo quasi
  identico) e batte kimi (coding più alto in assoluto, 76.2, ma ~95× più
  caro del più economico — ben fuori dalla fascia dei "quasi economico
  allo stesso modo").
- **support** → `deepseek-v4-flash@opencode-bacin` (o
  `deepseek-v4-flash@opencode-alessio`, stesso prezzo) — il più economico
  tra chi supera la soglia di coding 60; kimi e qwen restano esclusi
  perché troppo costosi, anche se qwen supererebbe la soglia di coding.

## Come si passa il pin a Pi

Il valore `pinned_id` è un identificatore del catalogo llmProxy nel formato
`model-id@provider-id`, non un nome
di provider Pi. Con la configurazione standard di Pi, che espone il solo
provider locale `llmproxy`, il pin va passato così:

```bash
pi --provider llmproxy --model 'z-ai/glm-5.3-flash@openrouter-glm' ...
```

Per lasciare a Yano la traduzione senza comporre manualmente i flag Pi, il
planner usa `yano start --llmproxy-pin
'z-ai/glm-5.3-flash@openrouter-glm' --print-only` e inoltra a Herdr il comando
stampato.

Non usare `--provider openrouter-glm --model z-ai/glm-5.3-flash` e non usare
`openrouter-glm:z-ai/glm-5.3-flash`: il primo tenta di risolvere l'istanza come
provider Pi inesistente, il secondo non seleziona correttamente un'istanza
llmProxy e può causare un 400/fallback. Per lasciare a
llmProxy la scelta dinamica usare `--provider llmproxy --model llmproxy`.

Pi può mostrare `Using custom model id` perché il catalogo locale di Pi
dichiara il solo modello generico `llmproxy`; non è un fallimento. La prova
operativa è il footer `[llmproxy]` e l'assenza di `is returning: 4xx/5xx` nel
trace. Il watcher segnala soltanto il secondo caso come `model-runtime-fallback`.

## Uso da CLI

```bash
yano model-advisor catalog [--json]
yano model-advisor recommend --role-class coordinator|support [--vision] [--json]
yano model-advisor explain --role-class coordinator|support [--vision] [--json]
```

- `catalog` stampa il catalogo normalizzato così com'è ora (utile per un
  umano, o per il planner, prima di decidere).
- `recommend` stampa solo la scelta migliore e le alternative.
- `explain` stampa l'intera classifica con il motivo (in italiano) di
  ciascuna posizione, invece della sola scelta migliore.
- `--base-url`/`--api-key` sovrascrivono la configurazione per quella singola
  chiamata.

## Configurazione

```bash
yano config set YANO_LLMPROXY_URL http://127.0.0.1:7045   # default se omessa
yano config set YANO_LLMPROXY_API_KEY --stdin              # opzionale, solo se il gate di llmProxy è attivo

Le opzioni runtime di llmProxy possono essere salvate nello stesso registro
globale e vengono ereditate dai processi Pi/Yano:

```bash
yano config set LLMPROXY_INFERENCE_INFO_INLINE 1
yano config set LLMPROXY_METERING_INLINE 0
yano config set LLMPROXY_PROVIDER_CREDIT_INLINE 1
yano config set LLMPROXY_SHORT_ANSWER 0
```
```

Vedi anche `.env.example` per l'equivalente in un checkout di sviluppo.

## Nota tecnica — la forma reale di `GET /api/providers`

`GET /api/providers` di llmProxy **non** restituisce oggetti JSON
strutturati per provider: il suo server (`llmProxy/lib/app.js`) esegue
internamente `provider:list` e ne incapsula l'output testuale (lo stesso
identico testo di `llmproxy provider:list` da terminale) dentro una busta
JSON:

```json
{ "success": true, "exitCode": 0, "command": "provider:list",
  "data": { "output": "1. openrouter-glm (OpenRouter)\n   model=...", "error": "" },
  "timestamp": "..." }
```

Per questo `fetchProviderCatalog()` usa **lo stesso parser testuale**
(`parseProviderListText()`) sia per la risposta HTTP sia per il fallback
`llmproxy provider:list` eseguito in locale via `spawnSync` — l'unica
differenza è dove arriva quel testo. Il parser resta comunque difensivo
verso una futura risposta JSON realmente strutturata (array di oggetti con
`id`/`model`), nel caso llmProxy cambi forma in una versione successiva.

Un dettaglio del parsing che vale la pena annotare: quando il campo
`price=` di un provider è `n/a` (tipico dei provider a
abbonamento/subscription come `opencode-*`, che non hanno un prezzo diretto
noto a llmProxy), il prezzo usato è quello del campo `best=` — il miglior
prezzo di mercato noto per quel modello — invece di lasciare il prezzo
sconosciuto. Quando `price=` è presente, vince sempre quello (anche se
`best=` indica un prezzo più basso altrove, come nel caso di `qwen`/`kimi`
sopra): è il prezzo che il provider sta realmente applicando in questo
momento.

## Escalation: mai ri-suggerire il provider appena fallito

Quando un ticket viene rimesso in coda dopo un errore di inferenza
(`ticket_requeue`), il planner passa il provider appena fallito come
`current_provider_id`; questo viene inoltrato a `recommendModel({ roleClass,
excludeProviderId: current_provider_id })`, cosicché il provider che ha
appena restituito un errore non possa essere ri-suggerito subito dopo come
"la scelta migliore" — l'escalation propone sempre un'alternativa reale.

Il fallback automatico (`yano-model-fallback.mjs`) resta il primo livello,
completamente deterministico: un ruolo configurato con un modello statico
che fallisce l'inferenza passa a `llmproxy auto` senza intervento umano né
LLM. Se anche `llmproxy auto` risultasse irraggiungibile perché llmProxy
stesso non è in esecuzione, è il ciclo cron (`yano watcher supervise`) a
verificarlo e a riavviarlo — via il container Docker o la sessione pm2
registrati in `yano services`, si veda
["External service supervision"](../architecture/architecture.md#failure-and-recovery)
per il dettaglio del rilevamento pm2 automatico di llmProxy.
