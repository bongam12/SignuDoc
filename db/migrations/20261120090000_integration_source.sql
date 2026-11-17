-- Envelopes started by another app through the integration API
-- (src/app/api/integrations). The API key can only read envelopes that carry
-- one, so it never reaches documents people uploaded themselves.

alter table public.envelopes
  add column if not exists integration_source text,
  add column if not exists integration_reference text;

create index if not exists envelopes_integration_source_idx
  on public.envelopes (integration_source)
  where integration_source is not null;
