"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { destinoAposLogin } from "@/lib/destino-login";

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

  redirect(destinoAposLogin(String(formData.get("volta") ?? "")));
}

// Cadastro aberto fechado (06/10, logins separados por cliente): conta criada
// aqui nascia "central" e via todas as frotas. Conta nova agora so' pelo
// convite do KPI (api/acessos/criar-conta), ja' presa ao cliente certo.

// Sair: encerra a sessão e volta pro login.
export async function sair() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
