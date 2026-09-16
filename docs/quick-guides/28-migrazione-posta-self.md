# Migrazione job `posta-pubblicita-oraria` → scheduler autonomo (mode `self`)

> Da applicare POST-MERGE sul Mac dell'utente, con i job produttivi esistenti
> intatti fino al cutover. Preparato in T1 (task scheduler-autonomous),
> testato con `yano schedule run` in data-root isolato + dry-run live su
> Mail.app reale. NON eseguire in worktree: i job vivono nel data-root globale.

## Cosa cambia

| Aspetto | Prima (mode `yano-local-pc`) | Dopo (mode `self`) |
|---|---|---|
| Esecuzione | script `.cjs` → `yano local-pc ask --no-wait` → agente yano-local-pc (MQTT) classifica con MCP apple-mail | `yano-mail-triage.mjs` (nel pacchetto) esegue MATERIALMENTE: MCP apple-mail via stdio + llmProxy via HTTP, poi `delete_message` (Cestino) |
| yano-local-pc | occupato ogni ora dal triage | libero: solo one-off interattivi non schedulati |
| Credenziali | nessuna (passava per l'agente) | nessuna: apple-mail MCP è puro osascript (zero secret); llmProxy usa `x-api-key: proxy-local` su loopback (stessa convenzione Pi), override via env |
| Notifiche | riepilogo dall'agente sul canale configurato | `sendGlobalNotification()` (stesso canale del digest) |
| Sicurezza | invariata | dubbio → NON cancellare; mai delete definitiva; cap 200/run; idempotenza via `mail-triage-seen.json` (30gg) |

## Prerequisiti (verificati in T1)

- macOS + Mail.app configurato (il triage rifiuta non-macOS).
- llmProxy su `http://127.0.0.1:7045` (default; override `YANO_LLMPROXY_URL`).
- `@griches/apple-mail-mcp` installabile via `npx -y` (oppure
  `YANO_APPLE_MAIL_MCP_BIN=<path diretto>`).

## Procedura (10 min, reversibile)

```bash
# 0. Merge del task + update globale (porta yano-mail-triage.mjs nel pacchetto)
yano update

# 1. Dry-run live: classifica la posta vera, NON cancella, notifica il riepilogo
YANO_MAIL_DRY_RUN=1 node ~/.local/lib/node_modules/yano-orchestrator/scripts/yano-mail-triage.mjs

# 2. Crea lo stub nel folder persistente (pattern digest: stub chiama il motore)
STUB="$HOME/Library/Application Support/yano/data/scheduler/scripts/posta-pubblicita-self.mjs"
PKG="$HOME/.local/lib/node_modules/yano-orchestrator"
cat > "$STUB" <<EOF
#!/usr/bin/env node
import { runMailTriage } from "file://$PKG/scripts/yano-mail-triage.mjs";
const report = await runMailTriage();
console.log(JSON.stringify(report));
process.exit(report.ok ? 0 : 1);
EOF
chmod 700 "$STUB"

# 3. Registra il nuovo job self (stesso cron orario) e validalo SENZA eseguire
yano schedule add --name posta-pubblicita-self --project-root "$HOME" \
  --script "$STUB" --mode self --cron '0 * * * *' \
  --expected-consequence "triage posta eseguito, promo nel Cestino, riepilogo notificato"
yano schedule run --id <nuovo-id> --dry-run --json   # deve dire valid:true

# 4. Test dal vivo UNA volta (esegue davvero: cancella promo reale nel Cestino)
yano schedule run --id <nuovo-id> --json
yano schedule instances --id <nuovo-id> --limit 3 --json   # status completed

# 5. Solo se il test è OK: disabilita il job storico (NON rimuoverlo subito)
yano schedule disable --id job-posta-pubblicita-oraria-mu340n5r

# 6. Una settimana di osservazione: se tutto OK, rimuovi lo storico
yano schedule remove --id job-posta-pubblicita-oraria-mu340n5r
```

## Rollback (1 min)

```bash
yano schedule disable --id <nuovo-id>          # ferma il self
yano schedule enable --id job-posta-pubblicita-oraria-mu340n5r   # riattiva lo storico
```

## Env utili (tutti opzionali, solo a runtime)

| Var | Default | Effetto |
|---|---|---|
| `YANO_MAIL_DRY_RUN=1` | 0 | classifica soltanto, nessuna delete |
| `YANO_MAIL_MAX_DELETE` | 200 | cap cancellazioni per run |
| `YANO_MAIL_PER_BOX` | 25 | messaggi listati per INBOX |
| `YANO_MAIL_MAX_EXAMINE` | 60 | cap messaggi esaminati per run |
| `YANO_MAIL_SINCE_HOURS` | 48 | solo messaggi recenti |
| `YANO_LLMPROXY_URL` / `YANO_LLMPROXY_API_KEY` | loopback Pi | endpoint/auth LLM |
| `YANO_APPLE_MAIL_MCP_BIN` | auto (cache npx) | path diretto al server MCP |

## Note operative

- Primo run dopo anni di posta: `skipped_old` scarta il pregresso oltre 48h;
  ogni messaggio giudicato entra in `mail-triage-seen.json` (idempotente).
- `ok:false` (LLM/MCP giù) → exit 1 → il job resta attivo e riprova l'ora
  dopo; i messaggi non giudicati NON entrano in seen. Nessun rilancio a
  raffica: i job `self` con exit 0 sono `completed` (mai `dispatched`).
- Gli altri job non cambiano: `autoimprover-code-mem-settimanale`,
  `import-newmiodoc-bugs-hourly` e `Digest` sono già `self` e restano come sono.
