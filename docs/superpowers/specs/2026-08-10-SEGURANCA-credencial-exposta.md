# Achado de segurança: credencial de produção exposta — 10/08

**Achado por**: revisão final de branch (modelo mais capaz), confirmado
pelo controller via `gh repo view`.

## Fatos confirmados

1. **`github.com/Joaquim-Salles/transmonseg-seguranca` (mirror
   "MONITORAMENTO transmonseg") é PÚBLICO** — confirmado com `gh repo view
   transmonseg/transmonseg-seguranca --json visibility` →
   `{"visibility":"PUBLIC"}`. (O repo principal
   `transmonseg-seguranca-stopgap` é privado.)

2. **A senha real do `app_service` (Postgres de produção) está em texto
   puro em 6 arquivos no HEAD desse repo público**:
   - `scripts/backtest-desvio/carregar-corpus.mjs` (de hoje mais cedo)
   - `docs/superpowers/plans/2026-08-10-ativar-pontos-aprendidos.md`
   - `docs/superpowers/plans/2026-08-10-correcao-manual-pontos.md`
   - `docs/superpowers/specs/2026-08-10-correcao-manual-pontos-design.md`
   - `scripts/corrigir-pontos-manual.mjs`
   - (mais 1, provavelmente do plano do harness de desvio — não
     enumerado individualmente pela revisão)

3. **O Postgres do Contabo escuta em `0.0.0.0:5432` e `[::]:5432`** —
   aceita conexão de qualquer IP.

4. **Sem firewall**: `ufw` inativo, `iptables -L INPUT` com política
   `ACCEPT` e sem regras.

5. **`pg_hba.conf` permite senha de qualquer origem**: linha
   `hostssl all app_service 0.0.0.0/0 scram-sha-256`.

6. **A revisão confirmou conexão TCP bem-sucedida** de fora do VPS pra
   `169.58.73.94:5432` (não tentou login, só confirmou que a porta
   responde de fora).

7. **`app_service` tem privilégios amplos**: `SELECT, INSERT, UPDATE,
   DELETE, TRUNCATE, REFERENCES, TRIGGER` em `pontos_aprendidos`, e
   `DELETE` em 42 tabelas do banco (via `ALTER DEFAULT PRIVILEGES` do
   role `postgres` — não veio de nenhuma migration explícita, é grant
   default aplicado a toda tabela nova).

## Por que isso é grave, não teórico

Qualquer pessoa que ache o repo público (ou que ele apareça indexado)
consegue se conectar direto no banco de produção com a senha do
`app_service`, com permissão de escrita/apagar em praticamente todas as
tabelas do sistema de monitoramento — não é só leitura.

Agravante específico do trabalho de hoje: o mecanismo de correção manual
(`pontos_aprendidos.fonte='manual'`) foi desenhado pra ficar **protegido
pra sempre** contra o recálculo automático noturno. Isso significa que,
se alguém usar essa credencial vazada pra gravar uma posição errada como
`fonte='manual'`, o sistema **nunca vai se autocorrigir** — antes desse
mecanismo existir, o job noturno reescreveria qualquer posição adulterada
em até 24h.

## Ação recomendada (você disse que vai cuidar disso)

1. Trocar a senha do `app_service` no Postgres + atualizar `.env` nos
   dois processos (`transmonseg-temp`, `transmonseg-definitivo`).
2. Fechar a porta 5432 pra fora (bind só em `localhost`, ou firewall
   restringindo a IPs conhecidos) + apertar o `0.0.0.0/0` do
   `pg_hba.conf`.
3. Purgar a credencial dos arquivos citados acima (rotacionar a senha já
   resolve o risco prático — reescrever histórico do git é opcional
   depois disso, mas o literal não devia continuar lá).
4. Considerar se `app_service` devia ter `DELETE`/`TRUNCATE` em tudo, ou
   se vale restringir pra só o que a aplicação de fato usa (achado
   incidental, não é o foco principal, mas é o tipo de coisa que um
   vazamento de credencial explora sem dó).

## Nota técnica adicional (achado #2 da mesma revisão, relacionado)

O comentário da migration 034 (`GRANT INSERT, UPDATE ON pontos_aprendidos
TO app_service`) afirma que `app_service` só tinha `SELECT` antes — isso
está errado sobre a produção real: o role já tinha TODOS os privilégios
via um `ALTER DEFAULT PRIVILEGES` aplicado pelo `postgres` a toda tabela
nova, fora do controle das migrations versionadas neste repo. O GRANT
explícito da 034 foi um no-op em produção (mas é uma defesa correta pra
um ambiente novo/replicado do zero, onde esse default privilege pode não
existir — manter). Vale saber que os arquivos de migration NÃO são mais
a fonte de verdade completa dos grants de produção.
