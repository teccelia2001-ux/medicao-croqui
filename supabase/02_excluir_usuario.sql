-- Medição por Croqui — o administrador exclui um usuário pelo Painel › Ajustes.
-- Rodar uma vez no SQL Editor do projeto setor_de_qualidade (pode rodar de novo).
--
-- Vale para os dois apps (Medição de Campo e Medição por Croqui): o usuário é o mesmo.
-- Usuário que tem obra lançada (em qualquer um dos dois apps) NÃO é excluído: a obra
-- guarda quem mediu. Para tirar o acesso dele, desmarque "Ativo".

create or replace function public.medicao_excluir_usuario(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  v_obras int := 0;
  v_n int;
begin
  if not public.medicao_eh_admin() then
    raise exception 'Só o administrador exclui usuários.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Você não pode excluir o seu próprio usuário.';
  end if;
  if not exists (select 1 from public.medicao_supervisores where user_id = p_user_id) then
    raise exception 'Usuário não encontrado.';
  end if;

  if to_regclass('public.medicao_obras') is not null then
    execute 'select count(*) from public.medicao_obras where supervisor_id = $1' into v_n using p_user_id;
    v_obras := v_obras + v_n;
  end if;
  if to_regclass('public.medicao_croqui_obras') is not null then
    execute 'select count(*) from public.medicao_croqui_obras where supervisor_id = $1' into v_n using p_user_id;
    v_obras := v_obras + v_n;
  end if;
  if v_obras > 0 then
    raise exception 'Esse usuário tem % obra(s) lançada(s) e não pode ser excluído. Para tirar o acesso, desmarque Ativo.', v_obras;
  end if;

  -- a linha de medicao_supervisores e o login (identidades, sessões) saem junto
  delete from auth.users where id = p_user_id;
end $$;

revoke all on function public.medicao_excluir_usuario(uuid) from public, anon;
grant execute on function public.medicao_excluir_usuario(uuid) to authenticated;

select 'ok' as resultado;
