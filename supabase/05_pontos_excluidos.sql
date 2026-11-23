-- Medição por Croqui — lista dos pontos excluídos de propósito numa coluna própria.
-- Rodar uma vez no SQL Editor do projeto setor_de_qualidade (pode rodar de novo).
--
-- Até aqui a lista ia dentro do projeto (projeto.pontos_fora). Obra sem projeto anexado não
-- tinha onde mandar, e a trava do 04 recusava a exclusão de ponto com serviço nela.
-- A trava passa a aceitar o ponto que está em qualquer uma das duas listas.

alter table public.medicao_croqui_obras add column if not exists pontos_fora jsonb;

create or replace function public.croqui_nao_perde_pontos()
returns trigger language plpgsql as $$
declare
  v_fora jsonb := '[]'::jsonb;
  v_novos jsonb := coalesce(new.pontos, '[]'::jsonb);
  v_perdidos int;
begin
  if jsonb_typeof(new.pontos_fora) = 'array' then v_fora := v_fora || new.pontos_fora; end if;
  if jsonb_typeof(new.projeto -> 'pontos_fora') = 'array' then v_fora := v_fora || (new.projeto -> 'pontos_fora'); end if;
  select count(*) into v_perdidos
    from jsonb_array_elements(coalesce(old.pontos, '[]'::jsonb)) p
   where (jsonb_array_length(coalesce(p -> 'itens', '[]'::jsonb)) > 0
          or jsonb_array_length(coalesce(p -> 'fotos', '[]'::jsonb)) > 0
          or coalesce(trim(p ->> 'obs'), '') <> '')
     and not exists (select 1 from jsonb_array_elements(v_novos) q where q ->> 'id' = p ->> 'id')
     and not (v_fora ? (p ->> 'id'));
  if v_perdidos > 0 then
    raise exception 'Esta cópia da obra % está sem % ponto(s) lançado(s) que o banco tem. Nada foi gravado: atualize o app e abra a obra de novo.', new.numero, v_perdidos;
  end if;
  return new;
end $$;

drop trigger if exists croqui_nao_perde_pontos on public.medicao_croqui_obras;
create trigger croqui_nao_perde_pontos before update on public.medicao_croqui_obras
  for each row execute function public.croqui_nao_perde_pontos();

select 'ok' as resultado;
