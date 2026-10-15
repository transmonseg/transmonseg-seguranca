#!/bin/bash
# Watchdog do motor (auditoria 15/10, OP-08): o pg_cron mostra "succeeded" mesmo
# quando ~46% das chamadas dao timeout de 5 s e quando o motor nao grava nada --
# ninguem era avisado se o motor parasse. Este script (cron */2) confere tres
# relogios e avisa o dono por WhatsApp (alertar-dm.mjs):
#   1) ultima atualizacao de posicoes_atuais (tabela pequena; NAO usar max() em
#      posicoes_historico: 67 M linhas, seq scan a cada 2 min);
#   2) ultimo ciclo da Central (motor_lease id=1, adquirido_em);
#   3) ultimo ciclo do motor-romaneio (motor_lease id=2, adquirido_em).
# Limite: > 5 min em qualquer um. Avisa de novo a cada 30 min e avisa "voltou".
# Consulta que falha 3 vezes seguidas (~6 min) tambem alerta: banco fora do ar
# e' o pior caso de motor parado. DRY=1 so' imprime (nao mexe no estado).
# WATCHDOG_MIN="<pos>|<central>|<romaneio>" no ambiente pula a consulta (teste).
LIMITE_MIN=5
ESTADO=/var/tmp/watchdog-motor.alerta
FALHAS=/var/tmp/watchdog-motor.falhas

if [ -z "${WATCHDOG_MIN+x}" ]; then
  WATCHDOG_MIN=$(sudo -n -u postgres psql -d transmonseg -tAc "SELECT coalesce(round(extract(epoch FROM now()-(SELECT max(updated_at) FROM posicoes_atuais))/60)::text,'x') || '|' || coalesce((SELECT round(extract(epoch FROM now()-adquirido_em)/60)::text FROM motor_lease WHERE id=1),'x') || '|' || coalesce((SELECT round(extract(epoch FROM now()-adquirido_em)/60)::text FROM motor_lease WHERE id=2),'x')" 2>/dev/null | tr -d '[:space:]')
fi
IFS='|' read -r POS CENTRAL ROMANEIO <<< "$WATCHDOG_MIN"
LEITURA_OK=1
for v in "$POS" "$CENTRAL" "$ROMANEIO"; do
  case "$v" in ''|*[!0-9]*) LEITURA_OK=0;; esac
done
if [ "$LEITURA_OK" = 0 ]; then
  # sem leitura: conta falhas seguidas; 3 seguidas = banco fora do ar
  N=$(( $(cat "$FALHAS" 2>/dev/null || echo 0) + 1 ))
  [ -n "$DRY" ] || echo "$N" > "$FALHAS"
  echo "watchdog: leitura invalida ($WATCHDOG_MIN), falha $N seguida(s)"
  if [ "$N" -ge 3 ]; then
    POS=0; CENTRAL=0; ROMANEIO=0
    PROBLEMAS="nao consegui consultar o banco ha ${N} verificacoes seguidas (Postgres fora do ar ou disco cheio?); "
  else
    exit 0
  fi
else
  [ -n "$DRY" ] || rm -f "$FALHAS"
fi

PROBLEMAS="${PROBLEMAS:-}"
[ "$POS" -gt "$LIMITE_MIN" ] && PROBLEMAS="${PROBLEMAS}nenhuma posicao gravada ha ${POS} min; "
[ "$CENTRAL" -gt "$LIMITE_MIN" ] && PROBLEMAS="${PROBLEMAS}motor da Central sem iniciar ciclo ha ${CENTRAL} min; "
[ "$ROMANEIO" -gt "$LIMITE_MIN" ] && PROBLEMAS="${PROBLEMAS}motor-romaneio sem iniciar ciclo ha ${ROMANEIO} min; "

ALERTA="$(dirname "$0")/alertar-dm.mjs"
if [ -n "$PROBLEMAS" ]; then
  TEXTO="Motor de desvio parado: ${PROBLEMAS%; }. Sem isso nenhum desvio e' detectado. Conferir pm2 (transmonseg-definitivo) e pg_cron."
  echo "ALERTA: $TEXTO"
  [ -n "$DRY" ] || touch "$ESTADO"
  if [ -z "$DRY" ]; then
    # chave muda a cada 30 min: repete enquanto durar (alertar-dm limita 1 por chave a cada 6 h)
    node "$ALERTA" "watchdog-motor-$(date +%Y%m%d%H)$(( $(date +%-M) / 30 ))" "$TEXTO"
  fi
elif [ -f "$ESTADO" ]; then
  [ -n "$DRY" ] || rm -f "$ESTADO"
  TEXTO="Motor de desvio voltou ao normal (posicao ha ${POS} min, ciclos ha ${CENTRAL}/${ROMANEIO} min)."
  echo "OK: $TEXTO"
  [ -z "$DRY" ] || exit 0
  node "$ALERTA" "watchdog-motor-volta-$(date +%Y%m%d%H%M)" "$TEXTO"
else
  echo "motor ok (posicao ${POS} min, ciclos ${CENTRAL}/${ROMANEIO} min)"
fi
