# Transmonseg Central — Próximas Fases (Plano)

> **Execução:** INLINE (superpowers:executing-plans), sem subagentes. O orquestrador escreve, testa (Chrome/banco) e commita cada tarefa.

**Goal:** Evoluir o MVP no ar (https://transmonseg-seguranca.vercel.app) com mapa, segurança, camada de tiroteios, dashboards, rota Google e landing page.

**Stack add:** react-leaflet + OpenStreetMap tiles (mapa, sem API key); Supabase Auth; API Fogo Cruzado; Google Routes (cota grátis).

## Global Constraints
- Repo PÚBLICO: segredos só em env; nunca commitar `.env.local`.
- Design dark premium (fundo #0a0a0a, navy #9fb3ce, Geist), ícones SVG (sem emoji), sem travessão (—), português correto.
- Build tem que passar (`npm run build`) antes de cada deploy; função do motor em gru1 (São Paulo).
- Testar de verdade (Chrome/banco) antes de dar tarefa por concluída.

---

## FASE 6 — Mapa ao vivo (primeiro)
Objetivo: ver os veículos e as áreas de perigo (favelas) num mapa em tempo real.
- **6.1** Instalar `leaflet` + `react-leaflet`; CSS do Leaflet no layout. Componente `MapaFrota` (client) com tiles dark (CartoDB dark_matter, grátis).
- **6.2** Endpoint/loader que entrega os veículos do cliente (lat/lng, nível, placa) + os polígonos de favela (geofences) como GeoJSON. Plotar: marcador por veículo colorido pelo nível; favelas como polígonos vermelhos translúcidos; bases como círculos.
- **6.3** Popup no marcador (placa, status, entregas, botão "ver no mapa" já existe). Auto-fit aos veículos. Atualização junto com o AutoRefresh.
- **6.4** Integrar na tela: uma aba/visão "Mapa" (toggle Lista | Mapa) mantendo o seletor de cliente. Verificar no Chrome.

## FASE 5 — Login + Auth + RLS (segurança)
Objetivo: fechar a URL pública; operadores logam; cada um vê o que pode.
- **5.1** Supabase Auth (email/senha). Página `/login`. Middleware que protege as rotas (sem sessão → /login).
- **5.2** Tabela `operadores` (id=auth.users) com papel ('admin'|'operador'|'cliente') e cliente_id. Seed de um admin.
- **5.3** Policies RLS: admin/operador vê tudo; 'cliente' só o próprio cliente_id. A tela passa a ler com o cliente autenticado (anon+RLS) onde der; o motor continua service_role.
- **5.4** Testar: logar, ver isolamento; sem login redireciona.

## FASE 7 — Tiroteios (Fogo Cruzado)
- **7.1** Confirmar acesso à API Fogo Cruzado (auth JWT), guardar credenciais em env.
- **7.2** Job/rotina que busca tiroteios recentes do RJ e grava em `tiroteios` (geom point, data).
- **7.3** Camada no mapa (pontos de tiroteio recentes) + no motor: tiroteio recente perto eleva o risco do trecho/score.

## FASE 8 — Dashboards / relatórios
- **8.1** Tabela/uso de `eventos` para histórico. Tela `/analise`: linha do tempo de alertas, contagem por tipo/cliente/período.
- **8.2** Mapa de calor de incidentes (onde mais acontece alerta) usando os alertas históricos.
- **8.3** Métricas: tempo de resposta, recorrência por veículo.

## FASE 9 — Google Routes (rota esperada / off-route)
- **9.1** Ativar Routes API no projeto Google Cloud do usuário; env GOOGLE_MAPS_KEY.
- **9.2** Para veículos com alvos: calcular rota esperada 1x por viagem (cache), comparar posição com a rota (cross-track), alertar desvio sustentado.

## FASE 10 — Landing page
- **10.1** Rota `/sobre` (ou domínio à parte) com a apresentação do produto (reaproveitar a página de pitch transmonseg-seguranca worker), responsiva.

---

## Ordem de execução
6 (mapa) → 5 (login) → 7 (tiroteios) → 8 (dashboards) → 9 (Google) → 10 (LP).
Cada tarefa: escrever inline, testar (Chrome/banco), commit, push (deploy automático).
