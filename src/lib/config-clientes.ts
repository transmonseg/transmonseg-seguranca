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

// 21/09 (pedido do usuario: "volte tudo que dava certo"): em 21-27/08, quando
// o desvio/parada eram medidos como "muito melhores", a Central Unitrac rodava
// os 3 detectores de parada pra FROTA INTEIRA da Nutry Max (75 e 66 paradas
// corretas/dia em 25 e 27/08). O desligamento de 26/08 (752acca) zerou isso na
// aba Central que as operadoras monitoram (0 corretas/dia desde 28/08). true =
// Central Unitrac volta a rodar as paradas pra todo veiculo, mesmo com
// romaneio; a Central Romaneio segue rodando as dela (aba propria) -- custo
// aceito: possivel alerta duplicado entre as duas abas. Voltar a false
// restaura o comportamento por-veiculo de 14/09.
export const PARADA_CENTRAL_LIGADA_PARA_FROTA_INTEIRA = true;

// 21/09 (pedido do usuario, "deixar como dava certo"): chave mestra dos 3
// filtros que so' SUPRIMEM alerta de desvio e nao existiam em 24-27/08, quando
// o desvio era medido como "muito melhor": salto de reconciliacao (28/08),
// retorno a base estrito + horario avancado 14:30 (28/08 e 10/09) e saida da
// base sem destino (31/08). false = comportamento de 25/08 nos dois motores
// (Central Unitrac e Central Romaneio). Custo medido dos filtros: ~13
// incidentes engolidos/dia e 33/296 corretos atrasados no disparo; sem eles
// voltam os falsos "saindo/retornando da base" reclamados em 28/08-03/09.
// true religa os tres.
export const GATES_SUPRESSAO_DESVIO_ATIVOS = false;

// 21/09 (diagnostico com o gabarito do grupo DESVIO DE ROTA: 455 vereditos, 303
// alertas casados). Tres ajustes na visibilidade/prioridade do desvio da
// Central Unitrac, cada um com flag propria (true = ligado; false = comportamento
// anterior). Nenhum fecha, silencia ou remove alerta: so' muda QUANDO um
// episodio novo aparece e COM QUE prioridade. Ver lib/desvio-episodio.ts e
// lib/desvio-destinos.ts.

// Episodio novo (>= 10 min sem disparo) de um veiculo que JA tem desvio aberto
// reabre o alerta existente (sobe `desde`, volta a 'ativo', marca
// contexto.episodios) em vez de ficar escondido pelo dedupe por tipo. Medido:
// 445 de 892 episodios de 14-20/09 (50%) estavam escondidos sob alerta velho,
// contra 270 de 1066 (25%) em 24-28/08.
export const DESVIO_EPISODIO_NOVO_REABRE_ALERTA = true;

// "Afastando de todos" com ZERO pendente de cliente na lista de destinos (so'
// base/escala) vira desvio nivel 'atencao' / origem 'sem_destinos' em vez de
// critico. Medido no gabarito: 71 falsos e 1 unico correto ambiguo (9E37 em
// 21/09, que a propria operadora disse que "deveria ser saida de base sem
// informacao"). Rebaixa, nunca silencia.
export const DESVIO_SEM_DESTINOS_REBAIXA_PARA_ATENCAO = true;

// Quando o filtro de 50 km tira TODOS os clientes pendentes (rota longa) e
// sobra so' a base, inclui o cliente pendente mais proximo na avaliacao de
// "afastando de todos". Medido no gabarito: 14 falsos, 0 corretos. Se o OSRM nao
// rotear ate esse cliente, a avaliacao cai de volta na lista antiga.
// Revisao adversarial (21/09): DESLIGADA por padrao. Incluir o cliente distante
// faz aproximandoAlgum ficar true durante a rota longa inteira (LIMIAR_TRANSITO_
// LONGO_M=300km), o que tambem desliga o Sinal B rua_rara e faz o streak
// decair -- reintroduz o mascaramento de 13/08 em escopo maior e nao foi
// medido por ciclo. So' liga depois de contrafactual por ciclo.
export const DESVIO_INCLUI_CLIENTE_DISTANTE_NA_LISTA = false;

// 22/09: correcao pendente desde 22/08 (docs/investigacoes/2026-08-21-
// marcacoes-faltantes.md). Quando a Unitrac nao tem NENHUM pendente pro
// veiculo mas ha' romaneio carregado hoje, usa os pontos do romaneio (ainda
// nao confirmados) como destino do desvio -- fallback puro, nunca mistura
// com Unitrac quando ela tem alvo. Roda ANTES do rebaixamento
// DESVIO_SEM_DESTINOS_REBAIXA_PARA_ATENCAO acima: so' cai nele quando NEM
// Unitrac NEM romaneio tem pendente.
export const DESVIO_USA_ROMANEIO_QUANDO_SEM_ALVO_UNITRAC = true;
