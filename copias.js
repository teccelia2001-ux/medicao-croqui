/* Cópias de segurança e backup em arquivo. O banco.js guarda as cópias sozinho; aqui ficam a
   lista, o Restaurar e o arquivo. O administrador usa na aba Backup do Painel; o supervisor,
   que não entra no Painel, em ⚙ Ajustes do app. `ctx` = { perfil, avisar, travado, obrasDoBanco }:
   quem chama diz quem está logado, como avisa e se o aparelho só consulta. */
(function () {
  const M = window.Medicao;
  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const MOTIVO = { "automática": "enquanto trabalhava", "do banco": "junto com o banco", "antes de restaurar": "antes de restaurar outra", arquivo: "veio de um arquivo" };
  /** obra de outro supervisor: só consulta (o banco só deixa o dono gravar) */
  const deOutro = (o, perfil) => !!o && (o.dono === false || (!!o.dono_id && !!perfil?.user_id && o.dono_id !== perfil.user_id));

  /** o que a tela precisa: as cópias (mais nova antes), as obras do aparelho e as abertas */
  async function carregar(abertas = new Set()) {
    await Banco.copiasProntas();
    const [lista, obras] = await Promise.all([Banco.listarCopias(), Banco.listarObras()]);
    return { lista: lista.sort((x, y) => String(y.em).localeCompare(String(x.em))), locais: new Set(obras.map((o) => o.id)), abertas };
  }

  const maisCompleta = (lista) => lista.reduce((m, x) => {
    const a = x.resumo || {}, b = m?.resumo || {};
    return !m || (a.lancados || 0) > (b.lancados || 0) || ((a.lancados || 0) === (b.lancados || 0) && (a.servicos || 0) > (b.servicos || 0)) ? x : m;
  }, null);

  function listaHtml(c, ctx) {
    const grupos = new Map();
    for (const x of c.lista) {
      if (!grupos.has(x.obraId)) grupos.set(x.obraId, []);
      grupos.get(x.obraId).push(x);
    }
    const linha = (x, maior) => {
      const r = x.resumo || {};
      const dono = deOutro(x.obra, ctx.perfil) ? x.obra.supervisor_nome || "outro supervisor" : "";
      return `<div class="copia${x === maior ? " copia-maior" : ""}">
        <div><b>${esc(M.fmtHora(x.em))}</b>${x === maior ? ` <span class="copia-selo">⭐ a mais completa</span>` : ""}
          <small class="sub">${plural(r.pontos || 0, "ponto", "pontos")}${r.vaos ? ` · ${plural(r.vaos, "vão", "vãos")}` : ""} · ${plural(r.servicos || 0, "serviço", "serviços")} · ${plural(r.fotos || 0, "foto", "fotos")}${r.valor != null ? ` · ${M.fmtMoeda(r.valor)}` : ""}</small>
          <small class="sub">Cópia ${esc(MOTIVO[x.motivo] || x.motivo || "")}</small></div>
        ${dono || ctx.travado ? `<small class="sub">só consulta${dono ? `<br>${esc(dono)}` : ""}</small>` : `<button type="button" class="botao botao-claro botao-pequeno" data-acao="restaurar-copia" data-id="${esc(x.id)}">↩ Restaurar</button>`}
      </div>`;
    };
    return [...grupos.entries()].map(([obraId, lista]) => {
      const aberta = c.abertas.has(obraId);
      const maior = aberta ? maisCompleta(lista) : null;
      return `<section class="cartao copias-obra">
        <button type="button" class="linha-topo copias-cab" data-acao="copias-abrir" data-obra="${esc(obraId)}" aria-expanded="${aberta}">
          <span class="chip-obra"><small>OBRA</small> <b>${esc(lista[0].numero || "")}</b></span>
          <small class="sub">${plural(lista.length, "cópia", "cópias")}${c.locais.has(obraId) ? "" : " · não está na lista deste aparelho"} ${aberta ? "▲" : "▼"}</small>
        </button>
        ${aberta ? lista.map((x) => linha(x, maior)).join("") : ""}
      </section>`;
    }).join("") || `<p class="vazio">Nenhuma cópia neste aparelho ainda. Elas aparecem sozinhas quando se lança alguma coisa numa obra.</p>`;
  }

  /** volta a obra como estava na cópia (a de agora vira outra cópia antes, dá para desfazer).
   *  Devolve a obra restaurada, marcada para envio, ou null. */
  async function restaurar(id, ctx) {
    const c = await Banco.obterCopia(id);
    if (!c) { ctx.avisar("Cópia não encontrada.", "erro"); return null; }
    const atual = await Banco.obterObra(c.obraId);
    if (ctx.travado || deOutro(c.obra, ctx.perfil) || deOutro(atual, ctx.perfil)) { ctx.avisar("Obra de outro supervisor: só consulta.", "erro"); return null; }
    const r = c.resumo || {};
    if (!confirm(`Restaurar a obra ${c.numero} como estava em ${M.fmtHora(c.em)}?\n\n${plural(r.pontos || 0, "ponto", "pontos")}, ${plural(r.servicos || 0, "serviço", "serviços")}, ${plural(r.fotos || 0, "foto", "fotos")}.\n\nO que a obra tem agora vira outra cópia antes (dá para voltar). O que está no banco e não está na cópia continua junto.`)) return null;
    if (atual) await Banco.guardarCopia(atual, "antes de restaurar", { forcar: true });
    const volta = JSON.parse(JSON.stringify(c.obra));
    const obra = atual
      ? { ...atual, ...volta, id: atual.id, dono: atual.dono, dono_id: atual.dono_id || volta.dono_id, base_em: atual.base_em, base_pontos: atual.base_pontos, rotulos: atual.rotulos || volta.rotulos || null, fotos_info: { ...(volta.fotos_info || {}), ...(atual.fotos_info || {}) } }
      : { ...volta, dono: true, dono_id: volta.dono_id || ctx.perfil?.user_id || null };
    // os pontos que voltam saem da lista dos excluídos de propósito (senão o banco os tiraria de novo)
    const voltam = new Set(obra.pontos.map((p) => p.id));
    obra.pontos_fora = (atual?.pontos_fora || volta.pontos_fora || []).filter((pid) => !voltam.has(pid));
    obra.erro_envio = null;
    // obra excluída deste aparelho: volta para a lista
    const ex = await Banco.ler("excluidas", []);
    if (ex.includes(obra.id)) await Banco.gravar("excluidas", ex.filter((x) => x !== obra.id));
    const fila = await Banco.ler("exclusoes", []);
    if (fila.includes(obra.id)) await Banco.gravar("exclusoes", fila.filter((x) => x !== obra.id));
    await Banco.salvarObra(obra);
    return obra;
  }

  /** linha do banco no formato da obra do app (como no trazerObra) */
  function linhaParaObra(r, resumo) {
    const { anotacoes = null, rotulos, pontos_fora: foraProj, ...proj } = r.projeto || {};
    return {
      id: r.id, numero: r.numero, local: r.local || "", municipio: r.municipio || "", departamento: r.departamento, equipe: r.equipe || "", obs: r.obs || "",
      pontos: r.pontos || [], fotos_info: r.fotos || {}, projeto: r.projeto ? proj : null, anotacoes, pontos_fora: r.pontos_fora || foraProj || [],
      criada_em: r.criada_em, atualizada_em: r.atualizada_em, dono_id: r.supervisor_id, supervisor_nome: resumo?.supervisor_nome || null,
    };
  }
  /** arquivo com as obras e cópias deste aparelho e, no Painel, as obras de todos no banco */
  async function baixarArquivo(ctx) {
    ctx.avisar("Montando o backup…", "guardado");
    await Banco.copiasProntas();
    const [obras, copias] = await Promise.all([Banco.listarObras(), Banco.listarCopias()]);
    const lista = ctx.obrasDoBanco || [];
    const banco = [];
    let falhas = 0;
    for (const [i, resumo] of lista.entries()) {
      ctx.avisar(`Baixando do banco: obra ${i + 1} de ${lista.length}…`, "guardado");
      try {
        const r = await Nuvem.baixarObra(resumo.id);
        if (r) banco.push(linhaParaObra(r, resumo));
      } catch (e) { falhas++; }
    }
    const dados = { tipo: "medicao-croqui-backup", versao_app: self.VERSAO_APP?.numero || null, gerado_em: new Date().toISOString(), supervisor: ctx.perfil?.nome || "", obras, copias, banco };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(dados)], { type: "application/json" }));
    a.download = `BACKUP MEDIÇÃO CROQUI ${new Date().toLocaleString("pt-BR").replace(/[/:]/g, "-").replace(", ", " ")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    const partes = `${lista.length ? `${plural(banco.length, "obra", "obras")} do banco, ` : ""}${plural(obras.length, "obra", "obras")} e ${plural(copias.length, "cópia", "cópias")} deste aparelho`;
    if (falhas) ctx.avisar(`Backup incompleto: ${plural(falhas, "obra não veio", "obras não vieram")} do banco. Baixe de novo com internet melhor. Foram: ${partes}.`, "erro", 12000);
    else ctx.avisar(`Backup baixado: ${partes}. Guarde o arquivo no computador ou no Drive.`, "ok", 8000);
  }

  /** as cópias e obras do arquivo entram como cópias (nada é trocado sem restaurar) */
  async function receberArquivo(arquivo, ctx) {
    if (!arquivo) return false;
    let dados = null;
    try { dados = JSON.parse(await arquivo.text()); } catch (e) { /* avisa abaixo */ }
    if (dados?.tipo !== "medicao-croqui-backup") { ctx.avisar("Esse arquivo não é um backup do app.", "erro"); return false; }
    let novas = 0;
    for (const c of dados.copias || []) if (await Banco.importarCopia({ ...c })) novas++;
    for (const o of [...(dados.obras || []), ...(dados.banco || [])]) {
      if (!o?.id) continue;
      // obra de outro supervisor guardada só para consulta: entra também, com o dono certo em dono_id
      if (await Banco.guardarCopia({ ...o, dono: o.dono === false ? undefined : o.dono }, "arquivo", { forcar: true })) novas++;
    }
    ctx.avisar(`${plural(novas, "cópia nova veio", "cópias novas vieram")} do arquivo de ${dados.gerado_em ? M.fmtHora(dados.gerado_em) : "backup"}. Restaure a que quiser.`, "ok", 8000);
    return true;
  }

  window.Copias = { carregar, listaHtml, restaurar, baixarArquivo, receberArquivo };
})();
