-- Medição por Croqui — tabela das obras e bucket dos arquivos, no projeto Supabase
-- "setor_de_qualidade". Rodar uma vez no SQL Editor (pode rodar de novo sem quebrar).
--
-- Usa o que a Medição de Campo já criou nesse banco (01_estrutura.sql e 03_usuarios.sql
-- de lá): os mesmos supervisores (medicao_supervisores), o mesmo catálogo
-- (medicao_servicos e medicao_valor_us) e as funções medicao_eh_supervisor,
-- medicao_eh_admin e medicao_recebida. Quem entra num app entra no outro.
-- As obras do croqui ficam separadas das da Medição de Campo.

-- ---------------------------------------------------------------- obras
-- A obra inteira num documento, igual à Medição de Campo. Cada ponto guarda também
-- onde fica no croqui: "croqui": {"pag": 1, "x": 0.53, "y": 0.61} (fração da folha).
-- "projeto": nome, tipo e data do arquivo do projeto (o arquivo vai para o bucket).
create table if not exists public.medicao_croqui_obras (
  id uuid primary key,
  numero text not null,
  local text,
  municipio text,
  departamento text,
  equipe text,
  obs text,
  pontos jsonb not null default '[]'::jsonb,
  fotos jsonb not null default '{}'::jsonb,
  projeto jsonb,
  total numeric(14, 2) not null default 0,
  total_us double precision not null default 0,
  qtd_pontos integer not null default 0,
  supervisor_id uuid not null default auth.uid() references auth.users (id),
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  recebida_em timestamptz not null default now()
);
create index if not exists medicao_croqui_obras_numero on public.medicao_croqui_obras (numero);
create index if not exists medicao_croqui_obras_supervisor on public.medicao_croqui_obras (supervisor_id);

-- mesma regra da Medição de Campo: marca quando chegou e o dono não muda
drop trigger if exists medicao_croqui_recebida on public.medicao_croqui_obras;
create trigger medicao_croqui_recebida before insert or update on public.medicao_croqui_obras
  for each row execute function public.medicao_recebida();

-- nome do supervisor junto da obra, para a lista do app e do painel
create or replace view public.medicao_croqui_obras_lista with (security_invoker = true) as
select o.id, o.numero, o.local, o.municipio, o.departamento, o.equipe, o.total, o.total_us,
       o.qtd_pontos, o.supervisor_id, s.nome as supervisor_nome, (o.projeto is not null) as tem_projeto,
       o.criada_em, o.atualizada_em, o.recebida_em
from public.medicao_croqui_obras o
left join public.medicao_supervisores s on s.user_id = o.supervisor_id;

-- ---------------------------------------------------------------- regras (RLS)
alter table public.medicao_croqui_obras enable row level security;

-- todo supervisor ativo lê todas as obras; grava e apaga só as suas
drop policy if exists "croqui obras ler" on public.medicao_croqui_obras;
create policy "croqui obras ler" on public.medicao_croqui_obras for select to authenticated
  using (public.medicao_eh_supervisor());
drop policy if exists "croqui obras criar" on public.medicao_croqui_obras;
create policy "croqui obras criar" on public.medicao_croqui_obras for insert to authenticated
  with check (public.medicao_eh_supervisor() and supervisor_id = auth.uid());
drop policy if exists "croqui obras alterar" on public.medicao_croqui_obras;
create policy "croqui obras alterar" on public.medicao_croqui_obras for update to authenticated
  using (public.medicao_eh_supervisor() and supervisor_id = auth.uid())
  with check (supervisor_id = auth.uid());
drop policy if exists "croqui obras apagar" on public.medicao_croqui_obras;
create policy "croqui obras apagar" on public.medicao_croqui_obras for delete to authenticated
  using (public.medicao_eh_supervisor() and (supervisor_id = auth.uid() or public.medicao_eh_admin()));

-- ---------------------------------------------------------------- arquivos
-- medicao-croqui/<obra_id>/<foto_id>.jpg  (fotos dos pontos)
-- medicao-croqui/projetos/<obra_id>.pdf   (projeto da obra; .jpg/.png se for imagem)
-- Privado; até 50 MB por arquivo (limite do plano gratuito).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('medicao-croqui', 'medicao-croqui', false, 52428800, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "croqui arquivos ler" on storage.objects;
create policy "croqui arquivos ler" on storage.objects for select to authenticated
  using (bucket_id = 'medicao-croqui' and public.medicao_eh_supervisor());
drop policy if exists "croqui arquivos enviar" on storage.objects;
create policy "croqui arquivos enviar" on storage.objects for insert to authenticated
  with check (bucket_id = 'medicao-croqui' and public.medicao_eh_supervisor());
drop policy if exists "croqui arquivos trocar" on storage.objects;
create policy "croqui arquivos trocar" on storage.objects for update to authenticated
  using (bucket_id = 'medicao-croqui' and owner_id = auth.uid()::text);
drop policy if exists "croqui arquivos apagar" on storage.objects;
create policy "croqui arquivos apagar" on storage.objects for delete to authenticated
  using (bucket_id = 'medicao-croqui' and (owner_id = auth.uid()::text or public.medicao_eh_admin()));
