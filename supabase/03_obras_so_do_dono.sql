-- Medição por Croqui — acesso comum (supervisor) vê só as próprias obras.
-- Rodar uma vez no SQL Editor do projeto setor_de_qualidade (pode rodar de novo).
--
-- Antes: todo supervisor ativo lia todas as obras (e as fotos e projetos delas).
-- Agora: o supervisor lê só as obras que ele lançou; o administrador lê todas.
-- Gravar e apagar continuam como estavam (só o dono; apagar também o administrador).
-- Só mexe nas obras do Croqui: a Medição de Campo (medicao_obras) não muda.

drop policy if exists "croqui obras ler" on public.medicao_croqui_obras;
create policy "croqui obras ler" on public.medicao_croqui_obras for select to authenticated
  using (public.medicao_eh_supervisor() and (supervisor_id = auth.uid() or public.medicao_eh_admin()));

-- arquivos: medicao-croqui/<obra_id>/<foto>.jpg e medicao-croqui/projetos/<obra_id>.pdf
-- o supervisor lê os da obra dele (ou o que ele mesmo enviou); o administrador lê todos
drop policy if exists "croqui arquivos ler" on storage.objects;
create policy "croqui arquivos ler" on storage.objects for select to authenticated
  using (
    bucket_id = 'medicao-croqui' and public.medicao_eh_supervisor() and (
      public.medicao_eh_admin()
      or owner_id = auth.uid()::text
      or exists (
        select 1 from public.medicao_croqui_obras o
         where o.supervisor_id = auth.uid()
           and o.id::text = case
             when (storage.foldername(name))[1] = 'projetos' then split_part(storage.filename(name), '.', 1)
             else (storage.foldername(name))[1]
           end
      )
    )
  );

select 'ok' as resultado;
