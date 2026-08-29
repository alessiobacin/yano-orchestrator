# Patch suggerita per docs/playbook-catalog.md

## 1. Riga da aggiungere alla tabella "Mapping"

| `qa-full-audit` | qa-inventory-analyst, qa-functional-verifier (+ specialisti QA/security/perf esistenti coordinati in parallelo) | canonical command/feature matrix with source, PASS/FAIL/BLOCKED verdict and evidence per entry, full matrix re-run after remediation, zero open blocking findings |

## 2. Bullet da aggiungere alla sezione "Specialist checklists"

- Quality gate: map every documented command/flag/endpoint before testing;
  never guess an expected result without a traceable source; classify
  BLOCKED (missing prerequisite/capability) separately from FAIL (real
  defect); route every blocking finding through the normal coder/reviewer or
  frontend-developer/frontend-reviewer cycle — this playbook never
  implements fixes itself; re-run the full matrix (not only the fixed
  items) before declaring the gate clean; when the reference project is
  Yano itself, run its existing internal test/lint suite first
  (`npm test`, `npm run lint:capabilities`, `npm run lint:playbooks`,
  `npm run check-skill-isolation`, `npm run check-syntax`, `yano doctor`)
  and use the matrix only to close the gaps that suite does not cover
  (documentation-vs-behavior drift, untested flag combinations,
  cross-command claims).

## 3. Nota per prompts/planner.md (facoltativa, non strettamente necessaria)

Il meccanismo di selezione playbook esistente (`yano architect assess`,
`yano playbook candidates`) è già generico e instraderà automaticamente una
richiesta come "fai un controllo qualità su questo progetto per vedere se
tutto funziona come dovrebbe" verso `qa-full-audit` una volta che il
playbook è promosso nel catalogo globale, purché `label`/`description`
contengano le parole chiave usate dall'utente (qualità, verifica
funzionale, audit, self-check, comandi). Non serve quindi modificare
`prompts/planner.md` per instradare questa richiesta: basta che il
planner, per un task non banale, esegua comunque
`yano architect assess --project-root <root> --task "<task>" --json` come
già prescritto.
