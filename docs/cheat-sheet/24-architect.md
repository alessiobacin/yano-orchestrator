# yano architect

Valuta i playbook, prepara proposte generiche e verifica/promuove i candidati.

~~~bash
yano architect assess --task "Descrizione task" --project-root "$PWD" --json
yano architect candidates --task "Descrizione task" --project-root "$PWD" --json
yano architect propose --task "Descrizione task" --project-root "$PWD" --new-playbook
yano architect provision --proposal-id PROP_ID --install
yano architect verify --proposal-id PROP_ID --json
yano architect promote --proposal-id PROP_ID --yes
yano architect create --type playbook --name <id> --task "..."
yano architect create --type cli --name <id> --task "..."
yano architect create --type skill --name <id> --task "..."
yano architect create --type mcp-server --name <id> --task "..."
~~~

L’architect è un worker esterno globale: viene attivato per proposta/import e
controlla requisiti, skill, CLI e MCP prima dell’uso.
