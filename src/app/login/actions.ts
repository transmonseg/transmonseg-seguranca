"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type EstadoAuth = { erro?: string; ok?: string };

const emailValido = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Login com email + senha.
export async function entrar(_prev: EstadoAuth, formData: FormData): Promise<EstadoAuth> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const senha = String(formData.get("senha") ?? "");
  if (!emailValido(email) || !senha) return { erro: "Informe email e senha." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
  if (error) return { erro: "Email ou senha incorretos." };

  redirect("/");
}

// Cadastro aberto (decisão do produto): cria o operador já confirmado e entra.
// Para trancar depois, basta restringir aqui (ex.: exigir dominio @transmonseg
// ou status 'pendente' aprovado por um admin) sem mexer no resto do sistema.
export async function cadastrar(_prev: EstadoAuth, formData: FormData): Promise<EstadoAuth> {
  const nome = String(formData.get("nome") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const senha = String(formData.get("senha") ?? "");

  if (!nome) return { erro: "Informe seu nome." };
  if (!emailValido(email)) return { erro: "Email invalido." };
  if (senha.length < 6) return { erro: "A senha precisa de ao menos 6 caracteres." };

  const admin = createAdminClient();
  const { data: criado, error: erroCriar } = await admin.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { nome },
  });
  if (erroCriar) {
    const m = erroCriar.message.toLowerCase();
    if (m.includes("already") || m.includes("registered") || m.includes("exists")) {
      return { erro: "Esse email ja tem conta. Faca login." };
    }
    return { erro: "Nao foi possivel criar a conta." };
  }

  // Registro espelho em operadores (operadores.id referencia auth.users.id).
  // papel 'operador', cliente_id null = central que vê todas as frotas.
  if (criado?.user?.id) {
    await admin.from("operadores").upsert(
      { id: criado.user.id, nome, papel: "operador" },
      { onConflict: "id", ignoreDuplicates: true }
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
  if (error) return { ok: "Conta criada. Faca login." };

  redirect("/");
}

// Sair: encerra a sessão e volta pro login.
export async function sair() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
