select cron.schedule(
  'limpar-escala-pontos',
  '0 4 * * *',
  $$delete from escala_pontos where criado_em < now() - interval '30 days'$$
);
