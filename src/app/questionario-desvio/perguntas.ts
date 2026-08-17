// Perguntas do questionario de opiniao sobre as regras do detector de
// desvio v2 -- fonte unica usada pela action (validacao) e pela pagina
// (render). Numeros e texto tem que bater com o que foi combinado com o
// usuario 17/08 (10 perguntas, sobre REGRA, nunca sobre caso especifico --
// dado historico ja existe de sobra no grupo do WhatsApp).
export type Pergunta = { numero: number; texto: string; opcoes: string[] };

export const PERGUNTAS: Pergunta[] = [
  {
    numero: 1,
    texto:
      "Sinal principal (afastando de tudo): o sistema considera desvio quando a distância real de rua até TODOS os clientes pendentes aumenta ao mesmo tempo, comparando a leitura de GPS de agora com a de ~30 segundos atrás. Ele não sabe a ordem que o motorista vai visitar cada um, só olha se afastou de todo mundo junto. Vocês concordam que é o jeito certo de pensar desvio, ou acham que devia ser diferente?",
    opcoes: ["Concordo, faz sentido", "Acho que devia ser diferente", "Não tenho certeza"],
  },
  {
    numero: 2,
    texto:
      "Velocidade de disparo: precisa de 2 leituras seguidas de afastamento (cerca de 1 minuto de GPS) pra disparar alerta crítico. Vocês preferem esse tempo, mais rápido (1 leitura, ~30 segundos), ou mais devagar (3 leituras, ~1min30)?",
    opcoes: ["Como está (1 minuto)", "Mais rápido (~30 segundos)", "Mais devagar (~1min30)"],
  },
  {
    numero: 3,
    texto:
      'Nível do alerta: todo desvio nasce direto como "crítico" (vermelho), não existe nível mais leve de "atenção" (amarelo) pra casos duvidosos. Concordam, ou faz sentido ter esse nível intermediário de novo?',
    opcoes: ["Concordo, só crítico", "Devia ter nível intermediário"],
  },
  {
    numero: 4,
    texto:
      "Viagem longa entre clientes distantes: o sistema só ignora a checagem de desvio quando o cliente pendente mais próximo está a mais de 300km de distância, ou seja, quase nunca ignora, na prática quase toda viagem é avaliada normalmente. Concordam que devia continuar avaliando quase sempre, ou acham que devia parar de avaliar desvio em viagens bem mais curtas que isso?",
    opcoes: ["Concordo, avaliar quase sempre (300km)", "Devia parar bem mais cedo (tipo 50-100km)", "Não tenho certeza"],
  },
  {
    numero: 5,
    texto:
      "Rua estreita: se o caminhão sai de uma via principal e entra numa rua estreita dentro de 10 minutos, o sistema reforça o alerta de desvio. Concordam com essa janela de 10 minutos, ou acham que devia ser mais curta ou mais longa?",
    opcoes: ["Concordo com 10 minutos", "Devia ser mais curta", "Devia ser mais longa"],
  },
  {
    numero: 6,
    texto:
      "Comparar com rota real (tipo Waze): o sistema checa se o trajeto desde o início do possível desvio bate com alguma rota real conhecida até os clientes pendentes, e reforça o alerta se não bater com nenhuma. Acham que essa comparação ajuda a confirmar desvio de verdade, ou atrapalha mais do que ajuda?",
    opcoes: ["Ajuda a confirmar", "Atrapalha mais que ajuda", "Não tenho certeza"],
  },
  {
    numero: 7,
    texto:
      "Rua rara pra frota: regra desligada hoje, que via desvio quando o caminhão entrava numa rua onde a frota inteira já passou 2 vezes ou menos no histórico. Foi desligada por dar alerta demais à toa. Concordam em manter desligada, ou acham que valia religar com um número diferente de visitas?",
    opcoes: ["Concordo, manter desligada", "Valia religar com outro número", "Não tenho certeza"],
  },
  {
    numero: 8,
    texto:
      "Prioridade geral: entre avisar rápido mesmo com mais alerta bobo no meio, ou avisar mais devagar só quando tiver mais certeza, qual vocês preferem que o sistema priorize?",
    opcoes: ["Avisar rápido, mesmo com mais alerta bobo", "Avisar mais devagar, só com mais certeza"],
  },
  {
    numero: 9,
    texto:
      'Parada fora do esperado: existe uma regra separada da regra de movimento, que dispara quando o caminhão FICA PARADO num lugar que não devia parar. Hoje ela aparece na tela com o MESMO nome "Desvio de rota" que a regra de movimento, mas por dentro são coisas diferentes. Vocês sabiam que eram regras separadas, ou sempre trataram como se fosse a mesma coisa?',
    opcoes: ["Sabia que eram separadas", "Sempre tratei como a mesma coisa"],
  },
  {
    numero: 10,
    texto:
      "Zona de folga perto da base: até 1.200 metros da base, o sistema não avalia desvio nenhum, pra não confundir manobra de pátio com desvio de verdade. Concordam com essa distância, ou acham que devia ser maior ou menor?",
    opcoes: ["Concordo com 1.200m", "Devia ser maior", "Devia ser menor"],
  },
];
