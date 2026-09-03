# E2E e review frontend: porte isolate

E2E simulator, frontend-developer e frontend-reviewer devono lavorare nel
worktree assegnato e allocare prima una coppia di porte:

```bash
yano test-env allocate --worktree /percorso/del/worktree --json
yano test-env show --worktree /percorso/del/worktree --json
yano test-env release --worktree /percorso/del/worktree --json
```

Yano usa intervalli dedicati (frontend `14200–14999`, backend
`13200–13999`), seleziona una coppia libera in modo deterministico per il
worktree e salva il mapping in `.pi/extensions/yano-orchestrator/config/`.
L'output contiene `frontend_url`, `backend_url`, `FRONTEND_PORT`, `API_PORT`,
`BACKEND_PORT` e `PLAYWRIGHT_BASE_URL`.

Una porta occupata non viene riusata alla cieca: il runner deve configurare il
framework sulle porte assegnate e verificare health/URL. Se il progetto non
supporta variabili d'ambiente, il runner deve passare le porte ai comandi del
framework. Non terminare processi di altri progetti e non dichiarare superato
un test rimasto su `about:blank`.
