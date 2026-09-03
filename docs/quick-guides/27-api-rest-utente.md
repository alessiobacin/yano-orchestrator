# REST API utente in Yano

Le REST API non sono capability predefinite di Yano. L’utente può registrarle
nel singolo progetto oppure nel catalogo globale. Il registro contiene URL,
descrizione, metodi autorizzati e il nome della variabile che contiene la
credenziale; non contiene mai il segreto.

```bash
yano config set WEBSITE_TO_MARKDOWN_API_KEY --stdin
yano api add --name website-to-markdown \
  --base-url https://w2m.otomatik.it \
  --postman "/Users/.../Website to Markdown API.postman_collection.json" \
  --description "Converte una pagina o un sito in Markdown" \
  --auth-config-key WEBSITE_TO_MARKDOWN_API_KEY --auth-header x-api-key

yano api add --scope global --name internal-search \
  --base-url https://api.example.com --spec ./openapi.yaml \
  --description "Ricerca interna documentale" --auth-config-key INTERNAL_SEARCH_TOKEN \
  --auth-header Authorization
```

Configura il segreto con `yano config set ... --stdin`. Per consultare e gestire
il registro:

```bash
yano api list --scope effective --project-root "$PWD" --json
yano api show --scope project --name website-to-markdown --json
yano api verify --scope project --name website-to-markdown --json
yano api refresh --scope project --name website-to-markdown --json
yano api update --scope project --name website-to-markdown --description "..."
yano api delete --scope project --name website-to-markdown
```

Ogni agente riceve solo le API abilitate e le descrizioni. Se una API è
pertinente può usare `api_request`, che impone host registrato, metodo
dichiarato, path relativo, timeout e credenziale configurata. Non esiste un
fetch arbitrario tramite questo tool.

`discover` mostra endpoint, metodi, parametri, body e risposte senza registrare
nulla. `add` esegue la stessa discovery e poi verifica automaticamente soltanto
le richieste GET sicure; POST/PUT/PATCH/DELETE vengono catalogate ma non
eseguite automaticamente. Se mancano `--postman` e `--spec`, è sufficiente
specificare `--base-url`: Yano mostra subito che sta tentando tramite
`yano-architect` e attende il risultato (timeout predefinito: tre minuti,
modificabile con `--timeout-ms`). Architect cerca una specifica OpenAPI/Swagger
realmente raggiungibile e testa solo GET/HEAD; non inventa endpoint e, se non
trova una sorgente o endpoint verificabili, il comando restituisce errore.

Architect può creare una nuova API globale in modalità ephemeral:

```bash
yano architect create --type rest-api --name document-search \
  --task "REST API per ricerca documentale con auth, validazione, test e OpenAPI"
```

La promozione richiede review del codice, test, installazione, prima esecuzione
riuscita e approvazione. Il codice generato è uno scaffold: Architect deve
completarlo e verificare contratto, autenticazione, errori, rate limit, SSRF,
logging senza segreti e documentazione.
