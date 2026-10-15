#!/bin/bash
# Watchdog do motor (auditoria 15/10, OP-08): o pg_cron mostra "succeeded" mesmo
# quando ~46% das chamadas dao timeout de 5 s e quando o motor nao grava nada --
# ninguem era avisado se o motor parasse. Este script (cron */2) confere tres
# relogios e avisa o dono por WhatsApp (alertar-dm.mjs):
#   1) ultima posicao gravada em posicoes_historico (motor da Central + Unitrac);
#   2) ultimo ciclo da Central (motor_lease id=1, adquirido_em);
#   3) ultimo ciclo do motor-romaneio (motor_lease id=2, adquirido_em).
# Limite: > 5 min em qualquer um. Avisa de novo a cada 30 min e avisa "voltou".
# Fail-open: consulta que falha nao alerta. DRY=1 so' imprime.
# WATCHDOG_MIN="<pos>|<central>|<romaneio>" no ambiente pula a consulta (teste).
LIMITE_MIN=5
ESTADO=/var/tmp/watchdog-motor.alerta

if [ -z "${WATCHDOG_MIN+x}" ]; then
  WATCHDOG_MIN=$(sudo -n -u postgres psql -d transmonseg -tAc "SELECT coalesce(round(extract(epoch FROM now()-(SELECT max(criado_em) FROM posicoes_historico))/60)::text,'x') || '|' || coalesce((SELECT round(extract(epoch FROM now()-adquirido_em)/60)::text FROM motor_lease WHERE id=1),'x') || '|' || coalesce((SELECT round(extract(epoch FROM now()-adquirido_em)/60)::text FROM motor_lease WHERE id=2),'x')" 2>/dev/null | tr -d '[:space:]')
fi
IFS='|' read -r POS CENTRAL ROMANEIO <<< "$WATCHDOG_MIN"
for v in "$POS" "$CENTRAL" "$ROMANEIO"; do
  case "$v" in ''|*[!0-9]*) echo "watchdog: leitura invalida ($WATCHDOG_MIN), nao avalia"; exit 0;; esac
done

PROBLEMAS=""
[ "$POS" -gt "$LIMITE_MIN" ] && PROBLEMAS="${PROBLEMAS}nenhuma posicao gravada ha ${POS} min; "
[ "$CENTRAL" -gt "$LIMITE_MIN" ] && PROBLEMAS="${PROBLEMAS}motor da Central sem iniciar ciclo ha ${CENTRAL} min; "
[ "$ROMANEIO" -gt "$LIMITE_MIN" ] && PROBLEMAS="${PROBLEMAS}motor-romaneio sem iniciar ciclo ha ${ROMANEIO} min; "

ALERTA="$(dirname "$0")/alertar-dm.mjs"
if [ -n "$PROBLEMAS" ]; then
  TEXTO="Motor de desvio parado: ${PROBLEMAS%; }. Sem isso nenhum desvio e' detectado. Conferir pm2 (transmonseg-definitivo) e pg_cron."
  echo "ALERTA: $TEXTO"
  touch "$ESTADO"
  if [ -z "$DRY" ]; then
    # chave muda a cada 30 min: repete enquanto durar (alertar-dm limita 1 por chave a cada 6 h)
    node "$ALERTA" "watchdog-motor-$(date +%Y%m%d%H)$(( $(date +%-M) / 30 ))" "$TEXTO"
  fi
elif [ -f "$ESTADO" ]; then
  rm -f "$ESTADO"
  TEXTO="Motor de desvio voltou ao normal (posicao ha ${POS} min, ciclos ha ${CENTRAL}/${ROMANEIO} min)."
  echo "OK: $TEXTO"
  [ -z "$DRY" ] || exit 0
  node "$ALERTA" "watchdog-motor-volta-$(date +%Y%m%d%H%M)" "$TEXTO"
else
  echo "motor ok (posicao ${POS} min, ciclos ${CENTRAL}/${ROMANEIO} min)"
fi
