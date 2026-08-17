"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { PERGUNTAS } from "./perguntas";

export type EstadoQuestionario = { ok?: boolean; erro?: string };

// Pagina publica, sem login (Erica/Ana/Elloisy nao sao operadores
// cadastrados) -- pedido direto do usuario 17/08 pra coletar opiniao sobre
// as regras do detector de desvio, nao dado historico (isso ja existe no
// grupo do WhatsApp). Uma linha por pergunta, nao um JSON por pessoa --
// pra dar pra agregar direto em SQL depois ("quantos concordam com a
// pergunta 3").
export async function enviarRespostas(
  _estadoAnterior: EstadoQuestionario,
  formData: FormData
): Promise<EstadoQuestionario> {
  const respondente = String(formData.get("respondente") ?? "").trim();
  if (!respondente) return { erro: "Escreve seu nome antes de enviar." };

  const linhas: {
    respondente: string;
    pergunta_numero: number;
    pergunta_texto: string;
    resposta: string;
    comentario: string | null;
  }[] = [];

  for (const p of PERGUNTAS) {
    const resposta = String(formData.get(`resposta_${p.numero}`) ?? "").trim();
    if (!resposta) return { erro: `Falta responder a pergunta ${p.numero}.` };
    const comentario = String(formData.get(`comentario_${p.numero}`) ?? "").trim();
    linhas.push({
      respondente,
      pergunta_numero: p.numero,
      pergunta_texto: p.texto,
      resposta,
      comentario: comentario || null,
    });
  }

  // Espaco livre no final (17/08, pedido direto: "bote pra pessoa
  // escrever") -- nao amarrado a nenhuma pergunta especifica, guardado com
  // pergunta_numero=99 pra caber no mesmo esquema de 1-linha-por-pergunta
  // sem precisar de coluna nova.
  const observacaoLivre = String(formData.get("observacao_livre") ?? "").trim();
  if (observacaoLivre) {
    linhas.push({
      respondente,
      pergunta_numero: 99,
      pergunta_texto: "Espaço livre — o que mais você acha que eu deveria saber",
      resposta: "(comentário livre)",
      comentario: observacaoLivre,
    });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("questionario_desvio_respostas").insert(linhas);
  if (error) return { erro: "Não deu pra enviar, tenta de novo." };

  return { ok: true };
}
