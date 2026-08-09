select cron.schedule(
  'limpar-pendentes-snapshot-log',
  '0 4 * * *',
  $$delete from pendentes_snapshot_log where criado_em < now() - interval '30 days'$$
);
