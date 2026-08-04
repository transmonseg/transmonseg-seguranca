--
-- PostgreSQL database dump
--

\restrict yGRACI9sEfkEYghO6J3NIG8KtMffexWvIaKiJf2hkK56iqeVNPa5OzxmG7rK1rR

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- EDITADO MANUALMENTE (Task 2): statement original abaixo removido.
-- CREATE SCHEMA public;
-- Motivo: o schema public ja existe por padrao em qualquer banco Postgres novo
-- (confirmado via \dn no Contabo antes da aplicacao). Manter o CREATE SCHEMA
-- geraria um erro espurio ("schema public already exists") no log de aplicacao;
-- removido para aplicacao limpa. Nao afeta as demais declaracoes (COMMENT ON
-- SCHEMA public, CREATE TABLE public.*, etc.), que nao dependem deste comando.

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: fn_favela_em(double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_favela_em(p_lat double precision, p_lng double precision) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select nome from geofences where tipo='favela'
    and ST_Intersects(geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat),4326)::geography) limit 1
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alertas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alertas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    veiculo_id uuid NOT NULL,
    nivel text NOT NULL,
    tipo text NOT NULL,
    motivo text NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'ativo'::text NOT NULL,
    lat double precision,
    lng double precision,
    geom public.geography(Point,4326),
    contexto jsonb DEFAULT '{}'::jsonb NOT NULL,
    desde timestamp with time zone DEFAULT now() NOT NULL,
    resolvido_em timestamp with time zone,
    operador_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alertas_nivel_check CHECK ((nivel = ANY (ARRAY['critico'::text, 'atencao'::text]))),
    CONSTRAINT alertas_status_check CHECK ((status = ANY (ARRAY['ativo'::text, 'reconhecido'::text, 'resolvido'::text, 'falso_positivo'::text])))
);


--
-- Name: baseline_frota; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baseline_frota (
    cliente_id uuid NOT NULL,
    tipo_viagem text NOT NULL,
    feature text NOT NULL,
    n_amostras bigint DEFAULT 0 NOT NULL,
    media double precision DEFAULT 0 NOT NULL,
    variancia double precision DEFAULT 0 NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: baseline_veiculo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baseline_veiculo (
    veiculo_id uuid NOT NULL,
    tipo_viagem text NOT NULL,
    feature text NOT NULL,
    n_amostras bigint DEFAULT 0 NOT NULL,
    media double precision DEFAULT 0 NOT NULL,
    variancia double precision DEFAULT 0 NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    nome text NOT NULL,
    geom public.geography(Geometry,4326) NOT NULL,
    raio_m integer DEFAULT 250,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calibracao_desvio; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calibracao_desvio (
    segmento text NOT NULL,
    n_amostras integer DEFAULT 0 NOT NULL,
    n_falso_positivo integer DEFAULT 0 NOT NULL,
    taxa_falso_positivo double precision DEFAULT 0 NOT NULL,
    score_ajustado double precision,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cerca_sombra; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cerca_sombra (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    veiculo_id uuid NOT NULL,
    cliente_id uuid NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    velocidade double precision NOT NULL,
    veredito text NOT NULL,
    pendentes integer NOT NULL,
    buffer_m integer NOT NULL
);


--
-- Name: clientes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clientes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nome text NOT NULL,
    cod_user_unitrac text NOT NULL,
    empresa_cod_unitrac text,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: corredor_celulas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corredor_celulas (
    cliente_id uuid NOT NULL,
    celula text NOT NULL,
    ultimo_visto date DEFAULT CURRENT_DATE NOT NULL,
    origem_celula text,
    destino_celula text
);


--
-- Name: corredor_celulas_veiculo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corredor_celulas_veiculo (
    veiculo_id uuid NOT NULL,
    celula text NOT NULL,
    ultimo_visto date DEFAULT CURRENT_DATE NOT NULL
);


--
-- Name: entregas_confirmacao_manual; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entregas_confirmacao_manual (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    veiculo_id uuid NOT NULL,
    alvo_codigo bigint NOT NULL,
    ponto_codigo bigint,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    distancia_m integer NOT NULL,
    parado_min integer NOT NULL,
    status text DEFAULT 'pendente'::text NOT NULL,
    detectado_em timestamp with time zone DEFAULT now() NOT NULL,
    resolvido_em timestamp with time zone,
    operador_id uuid,
    CONSTRAINT entregas_confirmacao_manual_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'confirmado'::text, 'rejeitado'::text])))
);


--
-- Name: eventos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eventos (
    id bigint NOT NULL,
    veiculo_id uuid,
    alerta_id uuid,
    tipo text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eventos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.eventos ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.eventos_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: geocode_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geocode_cache (
    lat numeric(8,4) NOT NULL,
    lng numeric(8,4) NOT NULL,
    endereco text,
    criado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: geofences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geofences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tipo text NOT NULL,
    nome text,
    fonte text,
    cliente_id uuid,
    geom public.geography(Geometry,4326) NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT geofences_tipo_check CHECK ((tipo = ANY (ARRAY['favela'::text, 'risco'::text, 'ponto_seguro'::text, 'cisp'::text, 'area_risco_cliente'::text])))
);


--
-- Name: motor_lease; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.motor_lease (
    id integer NOT NULL,
    expira_em timestamp with time zone DEFAULT now() NOT NULL,
    token uuid,
    adquirido_em timestamp with time zone
);


--
-- Name: operadores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operadores (
    id uuid NOT NULL,
    nome text NOT NULL,
    papel text DEFAULT 'operador'::text NOT NULL,
    cliente_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operadores_papel_check CHECK ((papel = ANY (ARRAY['admin'::text, 'operador'::text, 'cliente'::text])))
);


--
-- Name: poi_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.poi_cache (
    lat numeric(9,4) NOT NULL,
    lng numeric(9,4) NOT NULL,
    tem_poi boolean NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: posicoes_atuais; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posicoes_atuais (
    veiculo_id uuid NOT NULL,
    lat double precision,
    lng double precision,
    geom public.geography(Point,4326),
    velocidade integer,
    ignicao boolean,
    atraso_min integer,
    panico boolean DEFAULT false,
    bau_aberto boolean DEFAULT false,
    nivel text,
    motivo text,
    local text,
    datagps timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parado_desde timestamp with time zone,
    entregas_feitas integer DEFAULT 0,
    entregas_total integer DEFAULT 0,
    rumo smallint,
    ultimo_evento text,
    ultimo_evento_em timestamp with time zone,
    desvio_streak integer DEFAULT 0 NOT NULL,
    desvio_inicio jsonb,
    fora_tapete_streak integer DEFAULT 0 NOT NULL,
    aproximando_streak integer DEFAULT 0 NOT NULL,
    origem_celula text,
    no_raio_alvo_codigo integer,
    no_raio_desde timestamp with time zone,
    no_raio_dwell_segundos integer DEFAULT 0 NOT NULL,
    ultima_via_principal_em timestamp with time zone,
    divergencia_rumo_streak integer DEFAULT 0 NOT NULL
);


--
-- Name: posicoes_historico; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posicoes_historico (
    id bigint NOT NULL,
    veiculo_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    velocidade integer NOT NULL,
    ignicao boolean NOT NULL,
    atraso_min integer NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: posicoes_historico_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.posicoes_historico ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.posicoes_historico_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: romaneio_geocode_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.romaneio_geocode_cache (
    endereco_normalizado text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    fonte text NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: romaneio_pontos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.romaneio_pontos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    veiculo_id uuid,
    placa text NOT NULL,
    romaneio_data date NOT NULL,
    nf text NOT NULL,
    cliente_codigo text,
    cliente_nome text NOT NULL,
    endereco_bruto text NOT NULL,
    carga_destino_codigo text,
    carga_destino_nome text,
    lat double precision,
    lng double precision,
    geocode_status text DEFAULT 'pendente'::text NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    presenca_confirmada_em timestamp with time zone,
    modo_teste boolean DEFAULT false NOT NULL
);


--
-- Name: rota_perfil; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rota_perfil (
    cliente_id uuid NOT NULL,
    celula text NOT NULL,
    n_amostras integer DEFAULT 0 NOT NULL,
    media_m double precision DEFAULT 0 NOT NULL,
    variancia_m2 double precision DEFAULT 0 NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: unitrac_sessao; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unitrac_sessao (
    id integer DEFAULT 1 NOT NULL,
    cookie text NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    ok boolean DEFAULT true NOT NULL,
    CONSTRAINT unitrac_sessao_singleton CHECK ((id = 1))
);


--
-- Name: veiculos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.veiculos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    cv text NOT NULL,
    placa text NOT NULL,
    grupo text,
    perfil text DEFAULT 'auto'::text NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    unitrac_seriemodulo text,
    unitrac_protocolo text,
    unitrac_idprotocolo text,
    CONSTRAINT veiculos_perfil_check CHECK ((perfil = ANY (ARRAY['urbano'::text, 'estrada'::text, 'auto'::text])))
);


--
-- Name: vias_celulas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vias_celulas (
    celula text NOT NULL,
    classe text NOT NULL,
    CONSTRAINT vias_celulas_classe_check CHECK ((classe = ANY (ARRAY['principal'::text, 'intermediaria'::text, 'estreita'::text])))
);


--
-- Name: vias_nomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vias_nomes (
    id bigint NOT NULL,
    nome_normalizado text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL
);


--
-- Name: vias_nomes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.vias_nomes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.vias_nomes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: alertas alertas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alertas
    ADD CONSTRAINT alertas_pkey PRIMARY KEY (id);


--
-- Name: baseline_frota baseline_frota_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baseline_frota
    ADD CONSTRAINT baseline_frota_pkey PRIMARY KEY (cliente_id, tipo_viagem, feature);


--
-- Name: baseline_veiculo baseline_veiculo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baseline_veiculo
    ADD CONSTRAINT baseline_veiculo_pkey PRIMARY KEY (veiculo_id, tipo_viagem, feature);


--
-- Name: bases bases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bases
    ADD CONSTRAINT bases_pkey PRIMARY KEY (id);


--
-- Name: calibracao_desvio calibracao_desvio_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calibracao_desvio
    ADD CONSTRAINT calibracao_desvio_pkey PRIMARY KEY (segmento);


--
-- Name: cerca_sombra cerca_sombra_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cerca_sombra
    ADD CONSTRAINT cerca_sombra_pkey PRIMARY KEY (id);


--
-- Name: clientes clientes_cod_user_unitrac_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clientes
    ADD CONSTRAINT clientes_cod_user_unitrac_key UNIQUE (cod_user_unitrac);


--
-- Name: clientes clientes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clientes
    ADD CONSTRAINT clientes_pkey PRIMARY KEY (id);


--
-- Name: corredor_celulas corredor_celulas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corredor_celulas
    ADD CONSTRAINT corredor_celulas_pkey PRIMARY KEY (cliente_id, celula);


--
-- Name: corredor_celulas_veiculo corredor_celulas_veiculo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corredor_celulas_veiculo
    ADD CONSTRAINT corredor_celulas_veiculo_pkey PRIMARY KEY (veiculo_id, celula);


--
-- Name: entregas_confirmacao_manual entregas_confirmacao_manual_cliente_id_alvo_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entregas_confirmacao_manual
    ADD CONSTRAINT entregas_confirmacao_manual_cliente_id_alvo_codigo_key UNIQUE (cliente_id, alvo_codigo);


--
-- Name: entregas_confirmacao_manual entregas_confirmacao_manual_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entregas_confirmacao_manual
    ADD CONSTRAINT entregas_confirmacao_manual_pkey PRIMARY KEY (id);


--
-- Name: eventos eventos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eventos
    ADD CONSTRAINT eventos_pkey PRIMARY KEY (id);


--
-- Name: geocode_cache geocode_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geocode_cache
    ADD CONSTRAINT geocode_cache_pkey PRIMARY KEY (lat, lng);


--
-- Name: geofences geofences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofences
    ADD CONSTRAINT geofences_pkey PRIMARY KEY (id);


--
-- Name: motor_lease motor_lease_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motor_lease
    ADD CONSTRAINT motor_lease_pkey PRIMARY KEY (id);


--
-- Name: operadores operadores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operadores
    ADD CONSTRAINT operadores_pkey PRIMARY KEY (id);


--
-- Name: poi_cache poi_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poi_cache
    ADD CONSTRAINT poi_cache_pkey PRIMARY KEY (lat, lng);


--
-- Name: posicoes_atuais posicoes_atuais_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posicoes_atuais
    ADD CONSTRAINT posicoes_atuais_pkey PRIMARY KEY (veiculo_id);


--
-- Name: posicoes_historico posicoes_historico_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posicoes_historico
    ADD CONSTRAINT posicoes_historico_pkey PRIMARY KEY (id);


--
-- Name: romaneio_geocode_cache romaneio_geocode_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.romaneio_geocode_cache
    ADD CONSTRAINT romaneio_geocode_cache_pkey PRIMARY KEY (endereco_normalizado);


--
-- Name: romaneio_pontos romaneio_pontos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.romaneio_pontos
    ADD CONSTRAINT romaneio_pontos_pkey PRIMARY KEY (id);


--
-- Name: rota_perfil rota_perfil_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rota_perfil
    ADD CONSTRAINT rota_perfil_pkey PRIMARY KEY (cliente_id, celula);


--
-- Name: unitrac_sessao unitrac_sessao_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unitrac_sessao
    ADD CONSTRAINT unitrac_sessao_pkey PRIMARY KEY (id);


--
-- Name: veiculos veiculos_cliente_id_cv_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.veiculos
    ADD CONSTRAINT veiculos_cliente_id_cv_key UNIQUE (cliente_id, cv);


--
-- Name: veiculos veiculos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.veiculos
    ADD CONSTRAINT veiculos_pkey PRIMARY KEY (id);


--
-- Name: vias_celulas vias_celulas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vias_celulas
    ADD CONSTRAINT vias_celulas_pkey PRIMARY KEY (celula);


--
-- Name: vias_nomes vias_nomes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vias_nomes
    ADD CONSTRAINT vias_nomes_pkey PRIMARY KEY (id);


--
-- Name: cerca_sombra_criado_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cerca_sombra_criado_idx ON public.cerca_sombra USING btree (criado_em);


--
-- Name: idx_alertas_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertas_cleanup ON public.alertas USING btree (status, COALESCE(resolvido_em, created_at)) WHERE (status = ANY (ARRAY['resolvido'::text, 'falso_positivo'::text]));


--
-- Name: idx_alertas_cliente; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertas_cliente ON public.alertas USING btree (cliente_id);


--
-- Name: idx_alertas_desde; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertas_desde ON public.alertas USING btree (desde DESC);


--
-- Name: idx_alertas_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertas_status ON public.alertas USING btree (status);


--
-- Name: idx_alertas_veiculo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertas_veiculo ON public.alertas USING btree (veiculo_id);


--
-- Name: idx_bases_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bases_geom ON public.bases USING gist (geom);


--
-- Name: idx_corredor_celulas_veiculo_ultimo_visto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corredor_celulas_veiculo_ultimo_visto ON public.corredor_celulas_veiculo USING btree (ultimo_visto);


--
-- Name: idx_corredor_ultimo_visto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corredor_ultimo_visto ON public.corredor_celulas USING btree (ultimo_visto);


--
-- Name: idx_entregas_confirmacao_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entregas_confirmacao_status ON public.entregas_confirmacao_manual USING btree (cliente_id, status);


--
-- Name: idx_eventos_veiculo_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eventos_veiculo_ts ON public.eventos USING btree (veiculo_id, ts DESC);


--
-- Name: idx_geofences_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_geofences_geom ON public.geofences USING gist (geom);


--
-- Name: idx_geofences_tipo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_geofences_tipo ON public.geofences USING btree (tipo);


--
-- Name: idx_poi_cache_atualizado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_poi_cache_atualizado ON public.poi_cache USING btree (atualizado_em);


--
-- Name: idx_posatuais_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posatuais_geom ON public.posicoes_atuais USING gist (geom);


--
-- Name: idx_posatuais_nivel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posatuais_nivel ON public.posicoes_atuais USING btree (nivel);


--
-- Name: idx_veiculos_cliente; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_veiculos_cliente ON public.veiculos USING btree (cliente_id);


--
-- Name: idx_vias_nomes_nome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vias_nomes_nome ON public.vias_nomes USING btree (nome_normalizado);


--
-- Name: posicoes_historico_veiculo_tempo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX posicoes_historico_veiculo_tempo_idx ON public.posicoes_historico USING btree (veiculo_id, criado_em);


--
-- Name: romaneio_pontos_veiculo_data_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX romaneio_pontos_veiculo_data_idx ON public.romaneio_pontos USING btree (veiculo_id, romaneio_data);


--
-- Name: alertas alertas_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alertas
    ADD CONSTRAINT alertas_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;


--
-- Name: alertas alertas_operador_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alertas
    ADD CONSTRAINT alertas_operador_id_fkey FOREIGN KEY (operador_id) REFERENCES public.operadores(id) ON DELETE SET NULL;


--
-- Name: alertas alertas_veiculo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alertas
    ADD CONSTRAINT alertas_veiculo_id_fkey FOREIGN KEY (veiculo_id) REFERENCES public.veiculos(id) ON DELETE CASCADE;


--
-- Name: bases bases_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bases
    ADD CONSTRAINT bases_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;


--
-- Name: corredor_celulas corredor_celulas_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corredor_celulas
    ADD CONSTRAINT corredor_celulas_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;


--
-- Name: corredor_celulas_veiculo corredor_celulas_veiculo_veiculo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corredor_celulas_veiculo
    ADD CONSTRAINT corredor_celulas_veiculo_veiculo_id_fkey FOREIGN KEY (veiculo_id) REFERENCES public.veiculos(id) ON DELETE CASCADE;


--
-- Name: entregas_confirmacao_manual entregas_confirmacao_manual_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entregas_confirmacao_manual
    ADD CONSTRAINT entregas_confirmacao_manual_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;


--
-- Name: entregas_confirmacao_manual entregas_confirmacao_manual_operador_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entregas_confirmacao_manual
    ADD CONSTRAINT entregas_confirmacao_manual_operador_id_fkey FOREIGN KEY (operador_id) REFERENCES public.operadores(id);


--
-- Name: entregas_confirmacao_manual entregas_confirmacao_manual_veiculo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entregas_confirmacao_manual
    ADD CONSTRAINT entregas_confirmacao_manual_veiculo_id_fkey FOREIGN KEY (veiculo_id) REFERENCES public.veiculos(id) ON DELETE CASCADE;


--
-- Name: eventos eventos_alerta_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eventos
    ADD CONSTRAINT eventos_alerta_id_fkey FOREIGN KEY (alerta_id) REFERENCES public.alertas(id) ON DELETE SET NULL;


--
-- Name: eventos eventos_veiculo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eventos
    ADD CONSTRAINT eventos_veiculo_id_fkey FOREIGN KEY (veiculo_id) REFERENCES public.veiculos(id) ON DELETE CASCADE;


--
-- Name: geofences geofences_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofences
    ADD CONSTRAINT geofences_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;


--
-- Name: operadores operadores_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operadores
    ADD CONSTRAINT operadores_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE SET NULL;


-- EDITADO MANUALMENTE (Task 2): constraint original abaixo removida.
-- ALTER TABLE ONLY public.operadores
--     ADD CONSTRAINT operadores_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
-- Motivo: referencia o schema auth.* (Supabase Auth/GoTrue), que nao existe no
-- Postgres do Contabo nesta etapa (GoTrue so sera instalado na Task 8/9 do plano
-- de migracao). O schema public deve ficar isolado (confirmado na auditoria).
-- Reavaliar a recriacao desta FK apos a Task 9 (migracao de usuarios Auth pro GoTrue),
-- quando existir uma tabela equivalente a auth.users no Contabo.


--
-- Name: posicoes_atuais posicoes_atuais_veiculo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posicoes_atuais
    ADD CONSTRAINT posicoes_atuais_veiculo_id_fkey FOREIGN KEY (veiculo_id) REFERENCES public.veiculos(id) ON DELETE CASCADE;


--
-- Name: posicoes_historico posicoes_historico_veiculo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posicoes_historico
    ADD CONSTRAINT posicoes_historico_veiculo_id_fkey FOREIGN KEY (veiculo_id) REFERENCES public.veiculos(id);


--
-- Name: romaneio_pontos romaneio_pontos_veiculo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.romaneio_pontos
    ADD CONSTRAINT romaneio_pontos_veiculo_id_fkey FOREIGN KEY (veiculo_id) REFERENCES public.veiculos(id);


--
-- Name: rota_perfil rota_perfil_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rota_perfil
    ADD CONSTRAINT rota_perfil_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;


--
-- Name: veiculos veiculos_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.veiculos
    ADD CONSTRAINT veiculos_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;


--
-- Name: alertas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alertas ENABLE ROW LEVEL SECURITY;

--
-- Name: bases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bases ENABLE ROW LEVEL SECURITY;

--
-- Name: clientes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

--
-- Name: corredor_celulas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.corredor_celulas ENABLE ROW LEVEL SECURITY;

--
-- Name: entregas_confirmacao_manual; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entregas_confirmacao_manual ENABLE ROW LEVEL SECURITY;

--
-- Name: eventos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eventos ENABLE ROW LEVEL SECURITY;

--
-- Name: geofences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.geofences ENABLE ROW LEVEL SECURITY;

--
-- Name: operadores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operadores ENABLE ROW LEVEL SECURITY;

--
-- Name: posicoes_atuais; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.posicoes_atuais ENABLE ROW LEVEL SECURITY;

--
-- Name: rota_perfil; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rota_perfil ENABLE ROW LEVEL SECURITY;

--
-- Name: veiculos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.veiculos ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict yGRACI9sEfkEYghO6J3NIG8KtMffexWvIaKiJf2hkK56iqeVNPa5OzxmG7rK1rR

