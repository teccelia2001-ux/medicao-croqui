-- Medição por Croqui — o banco não deixa uma cópia velha apagar pontos lançados.
-- Rodar uma vez no SQL Editor do projeto setor_de_qualidade (pode rodar de novo).
--
-- Por quê: a obra sobe inteira e o banco guarda a última que chega. Um aparelho com uma cópia
-- velha (ou com o app antigo aberto) mandava a obra sem os pontos e apagava o que outro
-- aparelho tinha lançado (obra 0032601406, 23/11/2026).
--
-- Agora: se a obra que chega não tem um ponto que no banco tem serviço, foto ou observação,
-- e esse ponto não foi excluído de propósito (lista projeto.pontos_fora, que o app manda
-- desde a versão 91), o banco recusa a gravação. Nada se perde: o aparelho mostra
-- "⚠ Não enviada", e com o app atualizado a obra é juntada com a do banco.

create or replace function public.croqui_nao_perde_pontos()
returns trigger language plpgsql as $$
declare
  v_fora jsonb := coalesce(new.projeto -> 'pontos_fora', '[]'::jsonb);
  v_novos jsonb := coalesce(new.pontos, '[]'::jsonb);
  v_perdidos int;
begin
  if jsonb_typeof(v_fora) <> 'array' then v_fora := '[]'::jsonb; end if;
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
