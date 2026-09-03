# Memorie Yano

```bash
# Elenca memoria progetto, ruoli e istanze disponibili
yano memory agents --project-root "$PWD"

# Elenca tutti i file di memoria
yano memory list --project-root "$PWD" --json

# Mostra il riepilogo condiviso del progetto
yano memory show --scope project --project-root "$PWD"

# Mostra la memoria condivisa del ruolo coder
yano memory show --scope role --role coder --project-root "$PWD"

# Mostra la memoria diagnostica di una specifica istanza
yano memory show --scope instance --instance coder-01 --role coder --project-root "$PWD"

# CRUD manuale
yano memory create --scope role --role reviewer --text "..." --project-root "$PWD"
yano memory update --scope project --text "..." --project-root "$PWD"
yano memory delete --scope instance --instance coder-01 --role coder --project-root "$PWD"
```

La memoria progetto è breve e condivisa da tutti gli agenti. Le memorie di
ruolo non devono duplicare fatti già presenti nel riepilogo progetto.
