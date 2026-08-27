// Configuração de escopo POR CLIENTE compartilhada entre as duas centrais.
//
// Este módulo existe pra que a Central Unitrac (/api/motor) e a Central
// Romaneio (/api/motor-romaneio) leiam a MESMA lista -- antes da revisão final
// de branch (27/08) a constante só existia em motor/route.ts, e a Central
// Romaneio rodava os 3 detectores de parada pra TODO veículo com romaneio no
// dia, sem checar cliente. Hoje só a Nutry Max tem romaneio, então não há
// duplicata na prática; se qualquer outro cliente passar a ter romaneio, os 3
// detectores rodariam em DOBRO pra ele (Unitrac cobre normalmente + Romaneio
// também cobre). Duas cópias da mesma lista em arquivos diferentes é
// exatamente o jeito de esse bug aparecer sem ninguém notar.

// Clientes (cod_user_unitrac) cuja detecção de PARADA é responsabilidade
// exclusiva do motor-romaneio paralelo.
//
// Achado real 26/08 (grupo DESVIO DE ROTA, caso RBJ-2J67 "parada anômala
// falsa, veículo no cliente"): na Central Unitrac o `noCliente` é SEMPRE
// Unitrac (decisão de 31/07, "a Central NAO PODE MAIS ser afetada pelo
// romaneio") -- cliente cujo ponto existe no romaneio mas não tem alvo
// correspondente na Unitrac nunca conta como noCliente lá, e os detectores de
// parada "anômala" disparam falso todo santo dia pra esse gap. Decisão do
// usuário (26/08): Central continua 100% Unitrac, mas pro cliente coberto por
// motor-romaneio PARALELO (fonte de verdade pra ele) os detectores que
// dependem de noCliente (ParadaLonga/ParadaAnomala/ParadaForaTapete, ver
// montarCandidatosCore em detectores.ts) ficam DESLIGADOS na Central Unitrac.
//
// Logo, esta lista tem os dois lados da mesma moeda:
//   - motor/route.ts        : cliente NA lista => os 3 detectores DESLIGADOS
//   - motor-romaneio/route.ts: cliente NA lista => os 3 detectores LIGADOS
// Ou seja, exatamente um dos dois pipelines cobre cada cliente -- nunca zero
// (falso negativo, o erro caro aqui) e nunca dois (alerta duplicado).
export const CLIENTES_COM_MOTOR_ROMANEIO_PARALELO = new Set(["4096"]); // Nutry Max
