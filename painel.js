/* Painel do escritório: todas as obras medidas em campo, com filtros, totais,
   resumo por supervisor e o detalhe de cada obra (pontos, serviços, fotos e a
   medição em Excel/PDF no padrão do Termômetro). Usa o mesmo login do app. */
(function () {
  const M = window.Medicao;
  const $p = document.getElementById("painel");
  const $aviso = document.getElementById("aviso");
  const OPS = ["INSTALAR", "RETIRAR", "EXECUTAR"];

  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const normalizar = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const dia = (iso) => (iso ? iso.slice(0, 10) : "");

  let tempoAviso = null;
  function avisar(texto, tipo = "ok") {
    $aviso.textContent = texto;
    $aviso.className = `aviso aviso-${tipo}`;
    $aviso.hidden = false;
    clearTimeout(tempoAviso);
    tempoAviso = setTimeout(() => ($aviso.hidden = true), 3500);
  }

  const estado = {
    perfil: null,
    obras: null, // linhas de medicao_obras_lista
    usuarios: null, // medicao_supervisores (administrador)
    senhaDe: null, // usuário com o campo de nova senha aberto
    filtro: { busca: "", supervisor: "", cidade: "", de: "", ate: "" },
    ordem: { campo: "atualizada_em", desc: true },
    aberta: null, // obra completa aberta na gaveta
    fotos: new Map(), // fotoId -> objectURL
    gerando: false,
    aba: (() => {
      const h = location.hash.slice(1);
      if (["obras", "projetos", "ajustes"].includes(h)) return h;
      try { return localStorage.getItem("painel_aba") || "obras"; } catch (e) { return "obras"; }
    })(), // obras | projetos | ajustes
    baixandoProj: null, // obra com o projeto sendo baixado
    espacoHtml: "", // espaço deste aparelho (Ajustes)
    novaVersao: null, // { numero, data } quando saiu versão nova
    procurandoVersao: false,
  };
  const ABAS = [["obras", "📋", "Obras medidas", "Obras"], ["projetos", "🗺", "Projetos", "Projetos"], ["ajustes", "⚙", "Ajustes", "Ajustes"]];

  // ------------------------------------------------------------------ dados
  async function carregar(avisando = false) {
    try {
      estado.obras = await Nuvem.listarObras();
      render();
      if (avisando) avisar("Lista atualizada.");
    } catch (e) {
      if (e.status === 401) return sair();
      avisar(e.message, "erro");
    }
  }

  function filtradas() {
    const f = estado.filtro;
    const termos = normalizar(f.busca).split(/\s+/).filter(Boolean);
    const lista = (estado.obras || []).filter((o) => {
      if (f.supervisor && o.supervisor_nome !== f.supervisor) return false;
      if (f.cidade && (o.municipio || "") !== f.cidade) return false;
      const d = dia(o.atualizada_em);
      if (f.de && d < f.de) return false;
      if (f.ate && d > f.ate) return false;
      if (termos.length && !termos.every((t) => normalizar(`${o.numero} ${o.municipio} ${o.supervisor_nome}`).includes(t))) return false;
      return true;
    });
    const { campo, desc } = estado.ordem;
    const valor = (o) => (["total", "total_us", "qtd_pontos"].includes(campo) ? Number(o[campo]) || 0 : String(o[campo] || ""));
    lista.sort((a, b) => {
      const x = valor(a), y = valor(b);
      const r = x < y ? -1 : x > y ? 1 : 0;
      return desc ? -r : r;
    });
    return lista;
  }

  /** linha do banco no formato que o app e a medição usam */
  function obraDaLinha(r, lista) {
    const resumo = lista?.find((x) => x.id === r.id);
    return {
      id: r.id, numero: r.numero, local: r.local || "", municipio: r.municipio || "", equipe: r.equipe || "", obs: r.obs || "",
      pontos: r.pontos || [], fotos_info: r.fotos || {}, projeto: r.projeto || null, criada_em: r.criada_em, atualizada_em: r.atualizada_em,
      supervisor_nome: resumo?.supervisor_nome || "",
    };
  }

  /** Foto: do cache do navegador ou do banco (fica guardada para o PDF). */
  async function foto(obra, id) {
    let f = await Banco.obterFoto(id);
    const info = obra.fotos_info?.[id] || {};
    // guardada com a faixa antiga (o supervisor renomeou o ponto ou marcou a UTM depois): baixa de novo
    const velha = f && info.faixa_em && f.faixa_em !== info.faixa_em;
    if (!f || velha) {
      try {
        const blob = await Nuvem.baixarFoto(obra.id, id);
        f = { id, obraId: obra.id, pontoId: info.pontoId, blob, enviada: true, criada_em: info.criada_em, gps: info.gps, largura: info.largura, altura: info.altura, faixa_em: info.faixa_em || null };
        await Banco.salvarFoto(f);
      } catch (e) {
        if (!f) throw e; // sem a nova, fica a guardada
      }
    }
    return f;
  }

  /** Projeto (croqui) da obra: guardado no navegador ou baixado do banco. */
  async function projeto(obra) {
    if (!obra.projeto) return null;
    const local = await Banco.obterProjeto(obra.id);
    if (local && local.em === obra.projeto.em) return local;
    try {
      const blob = await Nuvem.baixarProjeto(obra.id, obra.projeto.tipo);
      const proj = { obraId: obra.id, blob, nome: obra.projeto.nome, tipo: obra.projeto.tipo, em: obra.projeto.em, enviado: true };
      await Banco.salvarProjeto(proj);
      return proj;
    } catch (e) {
      return local || null;
    }
  }

  /** o arquivo do projeto (croqui) da obra: abre numa aba nova ou baixa */
  async function arquivoProjeto(id, modo) {
    if (estado.baixandoProj) return;
    const janela = modo === "ver" ? window.open("", "_blank") : null; // aberta já no clique (senão o navegador bloqueia)
    estado.baixandoProj = id;
    render();
    avisar("Baixando o projeto…", "guardado");
    try {
      const r = await Nuvem.baixarObra(id);
      if (!r?.projeto) throw new Error("Essa obra não tem projeto anexado.");
      const proj = await projeto(obraDaLinha(r, estado.obras));
      if (!proj) throw new Error("Não deu para baixar o projeto.");
      const url = URL.createObjectURL(proj.blob);
      if (janela) janela.location = url;
      else {
        const a = document.createElement("a");
        a.href = url;
        a.download = proj.nome || `PROJETO OBRA ${r.numero}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      $aviso.hidden = true;
    } catch (e) {
      janela?.close();
      avisar(e.message, "erro");
    }
    estado.baixandoProj = null;
    render();
  }

  async function abrir(id) {
    try {
      avisar("Abrindo a obra…", "guardado");
      const r = await Nuvem.baixarObra(id);
      if (!r) return avisar("A obra não está mais no banco.", "erro");
      estado.aberta = obraDaLinha(r, estado.obras);
      $aviso.hidden = true;
      render();
      // miniaturas aos poucos
      for (const p of estado.aberta.pontos) {
        for (const fid of p.fotos) {
          if (estado.fotos.has(fid)) continue;
          try {
            const f = await foto(estado.aberta, fid);
            estado.fotos.set(fid, URL.createObjectURL(f.blob));
            const el = document.querySelector(`[data-foto="${fid}"]`);
            if (el) el.innerHTML = `<img src="${estado.fotos.get(fid)}" alt="Foto ${esc(p.nome)}">`;
          } catch (e) {
            const el = document.querySelector(`[data-foto="${fid}"]`);
            if (el) el.textContent = "sem foto";
          }
        }
      }
    } catch (e) {
      avisar(e.message, "erro");
    }
  }

  async function gerar(tipo, id) {
    if (estado.gerando) return;
    estado.gerando = true;
    avisar("Gerando o arquivo…", "guardado");
    try {
      let obra = estado.aberta?.id === id ? estado.aberta : null;
      if (!obra) obra = obraDaLinha(await Nuvem.baixarObra(id), estado.obras);
      if (tipo === "pdf") {
        let faltando = 0;
        for (const fid of obra.pontos.flatMap((p) => p.fotos)) {
          try { await foto(obra, fid); } catch (e) { faltando++; }
        }
        if (faltando) avisar(`${faltando} foto(s) não puderam ser baixadas: o PDF sai sem elas.`, "erro");
      }
      let croqui = null;
      if (tipo !== "xlsx" && obra.projeto) {
        try {
          const proj = await projeto(obra);
          if (proj) croqui = await Croqui.paraPdf(obra, proj, { recortes: tipo === "pdf" });
          else avisar("Não deu para baixar o projeto: o PDF sai sem o croqui.", "erro");
        } catch (e) {
          console.error(e);
          avisar("Não deu para desenhar o croqui: o PDF sai sem ele.", "erro");
        }
      }
      const arq = tipo === "xlsx"
        ? await M.gerarExcel(obra)
        : await M.gerarPdf(obra, { comFotos: tipo === "pdf", supervisor: obra.supervisor_nome, croqui });
      const url = URL.createObjectURL(arq.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = arq.nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      avisar("Arquivo pronto: " + arq.nome);
    } catch (e) {
      console.error(e);
      avisar(e.message || "Não foi possível gerar o arquivo.", "erro");
    }
    estado.gerando = false;
  }


  // ------------------------------------------------------------------ usuários (administrador)
  const FALTA_SQL = "Falta rodar o supabase/03_usuarios.sql no SQL Editor do Supabase.";
  const traduzir = (e) => (e.status === 404 || /could not find the function/i.test(e.message) ? FALTA_SQL : e.message);

  async function carregarUsuarios() {
    try {
      estado.usuarios = await Nuvem.supervisores();
    } catch (e) {
      estado.usuarios = [];
      avisar(traduzir(e), "erro");
    }
    render();
  }

  function usuariosHtml() {
    const eu = estado.perfil?.user_id;
    const obrasDe = (id) => (estado.obras || []).filter((o) => o.supervisor_id === id).length;
    const lista = estado.usuarios === null ? `<p class="vazio">Carregando…</p>`
      : estado.usuarios.map((u) => `<div class="usuario${u.ativo ? "" : " usuario-inativo"}">
        <div class="usuario-dados">
          <input class="usuario-nome" value="${esc(u.nome)}" data-u-nome="${u.user_id}" aria-label="Nome de ${esc(u.email)}">
          <small>${esc(u.email)} · ${obrasDe(u.user_id)} ${obrasDe(u.user_id) === 1 ? "obra" : "obras"}${u.user_id === eu ? " · você" : ""}</small>
        </div>
        <label class="chave"><input type="checkbox" data-u-ativo="${u.user_id}" ${u.ativo ? "checked" : ""} ${u.user_id === eu ? "disabled" : ""}> Ativo</label>
        <label class="chave"><input type="checkbox" data-u-admin="${u.user_id}" ${u.admin ? "checked" : ""} ${u.user_id === eu ? "disabled" : ""}> Administrador</label>
        ${estado.senhaDe === u.user_id
          ? `<form class="nova-senha" data-senha="${u.user_id}"><input type="password" id="nova-senha" minlength="6" placeholder="Nova senha (6+)" autocomplete="new-password" required><button class="mini">Salvar</button><button type="button" class="mini" data-acao="cancelar-senha">Cancelar</button></form>`
          : `<button type="button" class="mini" data-acao="abrir-senha" data-id="${u.user_id}">Trocar senha</button>`}
      </div>`).join("");
    return `<section class="bloco-ajuste">
          <h2 class="titulo-ajuste">👥 Usuários e acessos</h2>
          <form class="novo-usuario" id="form-usuario">
            <b>Novo usuário</b>
            <div class="novo-campos">
              <label>Nome <input id="u-nome" required placeholder="Nome que sai na medição"></label>
              <label>E-mail <input id="u-email" type="email" required autocomplete="off"></label>
              <label>Senha <input id="u-senha" type="password" minlength="6" required autocomplete="new-password" placeholder="6 ou mais"></label>
              <label class="chave"><input type="checkbox" id="u-admin"> Administrador</label>
              <button class="botao" id="bt-usuario">Criar usuário</button>
            </div>
            <small class="dica">O usuário entra no app e no painel com esse e-mail e senha. Administrador também cria usuários e muda acessos. Desativado não entra mais e não vê nada.</small>
          </form>
          <div class="cartao">${lista || `<p class="vazio">Nenhum usuário.</p>`}</div>
      </section>`;
  }

  // ------------------------------------------------------------------ telas
  function telaEntrar() {
    return `<div class="entrar-pagina"><form class="entrar" id="form-entrar">
      <img src="logo-teccel-red.png" alt="Teccel">
      <h1>Painel do croqui</h1>
      <p>Entre com o mesmo acesso do app.</p>
      <label>E-mail <input id="e-email" type="email" autocomplete="username" required></label>
      <label>Senha <input id="e-senha" type="password" autocomplete="current-password" required></label>
      <div class="erro" id="erro-entrar" hidden></div>
      <button class="botao" id="bt-entrar">Entrar</button>
    </form></div>`;
  }

  function opcoes(valores, escolhido, rotulo) {
    return `<option value="">${rotulo}</option>` + valores.map((v) => `<option ${v === escolhido ? "selected" : ""}>${esc(v)}</option>`).join("");
  }

  function th(campo, texto, num = false) {
    const o = estado.ordem;
    const seta = o.campo === campo ? `<span class="seta">${o.desc ? " ▼" : " ▲"}</span>` : "";
    return `<th data-ordem="${campo}" class="${num ? "num" : ""}">${texto}${seta}</th>`;
  }

  function abaObras() {
    const todas = estado.obras || [];
    const lista = filtradas();
    const f = estado.filtro;
    const linhas = lista.map((o) => `<tr data-abrir="${o.id}" class="${estado.aberta?.id === o.id ? "aberta" : ""}">
        <td><span class="chip-obra">${esc(o.numero)}</span></td>
        <td>${esc(o.municipio || "—")}</td>
        <td>${esc(o.supervisor_nome || "—")}</td>
        <td class="num">${o.qtd_pontos}</td>
        <td class="num">${M.fmtNum(Number(o.total_us || 0))}</td>
        <td class="num valor">${M.fmtMoeda(Number(o.total || 0))}</td>
        <td>${M.fmtHora(o.atualizada_em)}</td>
        <td><div class="acoes">
          <button type="button" class="mini" data-gerar="xlsx" data-id="${o.id}" title="Planilha Excel">Excel</button>
          <button type="button" class="mini" data-gerar="pdf" data-id="${o.id}" title="PDF com fotos">PDF</button>
        </div></td>
      </tr>`).join("");

    return `${pesquisa()}
          <section class="cartao">
            <h2>Obras medidas <small>${lista.length === todas.length ? `${todas.length}` : `${lista.length} de ${todas.length}`}</small></h2>
            <div class="rolagem"><table>
              <thead><tr>${th("numero", "Obra")}${th("municipio", "Cidade")}${th("supervisor_nome", "Supervisor")}${th("qtd_pontos", "Pontos", true)}${th("total_us", "US", true)}${th("total", "Valor", true)}${th("atualizada_em", "Alterada em")}<th>Medição</th></tr></thead>
              <tbody>${linhas}</tbody>
            </table></div>
            ${estado.obras === null ? `<p class="vazio">Carregando…</p>` : !lista.length ? `<p class="vazio">Nenhuma obra ${todas.length ? "encontrada" : "medida ainda"}.</p>` : ""}
          </section>`;
  }

  const pesquisa = () => `<section class="filtros">
      <label class="busca">Pesquisar obra <input id="f-busca" type="search" value="${esc(estado.filtro.busca)}" placeholder="Número da obra, cidade ou supervisor"></label>
      <button type="button" class="mini" data-acao="atualizar">⟳ Atualizar</button>
    </section>`;
  const comProjeto = (lista) => lista.filter((o) => o.tem_projeto !== false);

  function abaProjetos() {
    const todas = comProjeto(estado.obras || []);
    const lista = comProjeto(filtradas());
    const linhas = lista.map((o) => `<tr>
        <td><span class="chip-obra">${esc(o.numero)}</span></td>
        <td>${esc(o.municipio || "—")}</td>
        <td>${esc(o.supervisor_nome || "—")}</td>
        <td class="num">${o.qtd_pontos}</td>
        <td>${M.fmtHora(o.atualizada_em)}</td>
        <td><div class="acoes">
          <button type="button" class="mini" data-projeto="ver" data-id="${o.id}" ${estado.baixandoProj ? "disabled" : ""}>${estado.baixandoProj === o.id ? "Baixando…" : "👁 Abrir"}</button>
          <button type="button" class="mini" data-projeto="baixar" data-id="${o.id}" ${estado.baixandoProj ? "disabled" : ""}>⬇ Baixar</button>
          <button type="button" class="mini" data-abrir-obra="${o.id}">Ver obra</button>
        </div></td>
      </tr>`).join("");
    return `${pesquisa()}
      <section class="cartao">
        <h2>Projetos das obras <small>${lista.length === todas.length ? `${todas.length}` : `${lista.length} de ${todas.length}`}</small></h2>
        <div class="rolagem"><table>
          <thead><tr>${th("numero", "Obra")}${th("municipio", "Cidade")}${th("supervisor_nome", "Supervisor")}${th("qtd_pontos", "Pontos", true)}${th("atualizada_em", "Alterada em")}<th>Projeto (croqui)</th></tr></thead>
          <tbody class="sem-clique">${linhas}</tbody>
        </table></div>
        ${estado.obras === null ? `<p class="vazio">Carregando…</p>` : !lista.length ? `<p class="vazio">Nenhum projeto ${todas.length ? "encontrado" : "anexado ainda"}.</p>` : ""}
        <p class="dica dica-cartao">O projeto é o PDF (ou foto) que o supervisor anexou na obra, como foi enviado. A medição com o croqui marcado sai no PDF da aba Obras medidas.</p>
      </section>`;
  }

  // ------------------------------------------------------------------ este aparelho (vindo dos Ajustes do app)
  const ehIos = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  /** a mesma chave que o app lê ao tirar a foto (mesmo endereço = mesmo guardado no aparelho) */
  const copiaLigada = () => {
    try { return localStorage.getItem("croqui_copia_fotos") !== "nao"; } catch (e) { return true; }
  };
  const fmtTamanho = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace(".", ",")} GB`
    : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  async function medirEspaco() {
    try {
      const [esp, perm, todas] = await Promise.all([Banco.espaco(), Banco.persistente(), Banco.todasFotos()]);
      const medias = Math.max(250 * 1024, todas.length ? todas.reduce((t, f) => t + (f.blob?.size || 0), 0) / todas.length : 0);
      const resta = esp ? Math.max(0, esp.quota - esp.usage) : 0;
      estado.espacoHtml = `${esp ? `<div class="espaco-barra"><i style="width:${Math.min(100, (esp.usage / esp.quota) * 100).toFixed(1)}%"></i></div>
          <p class="dica"><b>${fmtTamanho(esp.usage)}</b> usados de <b>${fmtTamanho(esp.quota)}</b> que o aparelho libera para o app · cabem ainda cerca de <b>${Math.floor(resta / medias).toLocaleString("pt-BR")} fotos</b>.</p>` : `<p class="dica">Este aparelho não informa o espaço.</p>`}
        <p class="dica">${todas.length.toLocaleString("pt-BR")} fotos guardadas neste aparelho. ${perm ? "✓ Guarda permanente: o aparelho não apaga nada sozinho." : "⚠ O aparelho ainda não deu a guarda permanente. Instale o app na tela inicial para garantir."}</p>`;
    } catch (e) {
      estado.espacoHtml = `<p class="dica">Não deu para medir o espaço.</p>`;
    }
    const el = document.getElementById("espaco");
    if (el) el.innerHTML = estado.espacoHtml;
  }
  /** tamanho da tela como o aparelho enxerga (para achar o que corta num aparelho) */
  function medidaDaTela() {
    const vv = window.visualViewport;
    let txt = `${innerWidth}×${innerHeight} px · densidade ${(devicePixelRatio || 1).toFixed(2)}`;
    if (vv && Math.abs(vv.scale - 1) > 0.01) txt += ` · zoom da página ${vv.scale.toFixed(2)}`;
    if (screen?.width) txt += ` · aparelho ${screen.width}×${screen.height}`;
    return txt;
  }
  async function procurarVersao(manual = false) {
    if (!navigator.onLine) { if (manual) avisar("Sem internet para procurar atualização.", "erro"); return; }
    if (manual) { estado.procurandoVersao = true; render(); }
    try {
      const txt = await (await fetch("versao.js", { cache: "no-store" })).text();
      const numero = Number((txt.match(/numero:\s*(\d+)/) || [])[1]);
      const data = (txt.match(/data:\s*"([^"]*)"/) || [])[1] || "";
      estado.novaVersao = numero > Number(self.VERSAO_APP?.numero || 0) ? { numero, data } : null;
      if (manual && !estado.novaVersao) avisar("Você já está na versão mais nova.");
    } catch (e) {
      if (manual) avisar("Não deu para procurar agora. Tente de novo.", "erro");
    }
    estado.procurandoVersao = false;
    render();
  }
  /** a versão nova assume no aparelho (app e painel); a página recarrega */
  async function atualizarApp() {
    avisar("Atualizando…", "guardado");
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        const assumiu = new Promise((ok) => navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true }));
        await reg.update();
        await Promise.race([assumiu, new Promise((ok) => setTimeout(ok, 8000))]);
      }
    } catch (e) { /* recarrega assim mesmo */ }
    location.reload();
  }

  function abaAjustes() {
    const p = estado.perfil || {};
    const v = self.VERSAO_APP || {};
    const nv = estado.novaVersao;
    return `<section class="bloco-ajuste">
        <h2 class="titulo-ajuste">👤 Sua conta</h2>
        <div class="cartao cartao-ajuste">
          <p><b>${esc(p.nome || "")}</b> · ${esc(p.email || "")}${p.admin ? " · administrador" : ""}</p>
          <p class="dica">Mesmo acesso do app. O nome que sai na medição é o do cadastro. Sair daqui também sai do app neste aparelho.</p>
          <button type="button" class="botao botao-claro" data-acao="sair">Sair da conta</button>
        </div>
      </section>
      ${p.admin ? usuariosHtml() : ""}
      <section class="bloco-ajuste">
        <h2 class="titulo-ajuste">📱 Este aparelho</h2>
        <p class="dica">Vale para o celular (ou computador) em que o painel está aberto: o mesmo do app, no mesmo navegador.</p>
        <div class="cartao cartao-ajuste">
          <b>Fotos</b>
          ${ehIos()
            ? `<p class="dica">No iPhone o app não consegue salvar sozinho na galeria. No ponto, toque em <b>💾 Salvar as fotos no celular</b> e escolha <b>Salvar imagens</b>.</p>`
            : `<label class="chave chave-linha"><input type="checkbox" data-acao="copia-fotos" ${copiaLigada() ? "checked" : ""}>
                <span>Salvar uma cópia de cada foto tirada no celular <small>(pasta Download, aparece na galeria)</small></span></label>`}
          <p class="dica">As fotos também ficam guardadas no app e sobem para o banco.</p>
        </div>
        <div class="cartao cartao-ajuste">
          <b>Versão do app</b>
          <p>Você está na <b>versão ${esc(v.numero ?? "—")}</b>${v.data ? ` · de ${esc(v.data)}` : ""}.</p>
          <p class="dica">Tela deste aparelho: ${esc(medidaDaTela())}</p>
          ${nv ? `<p class="versao-nova">Nova versão ${esc(nv.numero)} disponível${nv.data ? ` (${esc(nv.data)})` : ""}.</p>
              <button type="button" class="botao" data-acao="atualizar-app">⬇ Atualizar agora</button>
              <small class="dica">O que foi lançado no app fica guardado; a página só recarrega.</small>`
            : `<button type="button" class="botao botao-claro" data-acao="procurar-versao" ${estado.procurandoVersao ? "disabled" : ""}>${estado.procurandoVersao ? "Procurando…" : "🔄 Procurar atualização"}</button>`}
        </div>
        <div class="cartao cartao-ajuste">
          <b>Espaço no aparelho</b>
          <div id="espaco" class="espaco">${estado.espacoHtml || `<p class="dica">Medindo…</p>`}</div>
        </div>
      </section>`;
  }

  function telaPainel() {
    const n = (estado.obras || []).length, np = comProjeto(estado.obras || []).length;
    const conta = { obras: estado.obras ? n : "", projetos: estado.obras ? np : "", ajustes: "" };
    const corpo = estado.aba === "projetos" ? abaProjetos() : estado.aba === "ajustes" ? abaAjustes() : abaObras();
    return `<header class="barra">
        <img src="logo-teccel-red.png" alt="Teccel">
        <h1>Painel da medição por croqui</h1>
        <span class="espaco"></span>
        <span class="quem">${esc(estado.perfil?.nome || "")}</span>
        <nav class="troca" aria-label="Trocar entre app e painel"><a href="./">📱 App</a><span class="ativo">📊 Painel</span></nav>
      </header>
      <div class="corpo">
        <nav class="lateral" aria-label="Abas do painel">
          ${ABAS.map(([id, ic, nome, curto]) => `<button type="button" class="lateral-aba${estado.aba === id ? " ativa" : ""}" data-aba="${id}" ${estado.aba === id ? 'aria-current="page"' : ""}>
            <span class="lateral-icone">${ic}</span><span class="lateral-nome">${nome}</span><span class="lateral-curto">${curto}</span>${conta[id] !== "" ? `<small>${conta[id]}</small>` : ""}</button>`).join("")}
          <span class="espaco"></span>
          <button type="button" class="lateral-aba lateral-sair" data-acao="sair"><span class="lateral-icone">⎋</span><span class="lateral-nome">Sair</span></button>
        </nav>
        <main class="conteudo">${corpo}</main>
      </div>
      ${gavetaHtml()}`;
  }

  function gavetaHtml() {
    const o = estado.aberta;
    if (!o) return "";
    const t = M.totaisObra(o);
    const secoes = M.estrutura(o.pontos).map((s) => `<div class="secao secao-${s.op.toLowerCase()}"><span>${esc(s.titulo)}</span><span>${M.fmtMoeda(s.subtotal)}</span></div>`).join("");
    const dias = o.pontos.filter((p) => p.itens.length && p.dia).map((p) => p.dia).sort();
    const pontos = M.ordenarPontos(o.pontos).map((p) => {
      const tp = M.totaisPonto(p);
      // mesmo padrão da medição geral: seção por operação e departamento, categorias e total
      const tabela = M.estrutura([p]).map((s) => {
        let n = 0;
        return `<tr class="med-secao"><th colspan="6">${esc(s.titulo)}</th></tr>
          <tr class="med-cab"><th>ITEM</th><th>COD</th><th>DESCRIÇÃO DO SERVIÇO</th><th class="num">QUANTIDADE</th><th class="num">TOTAL US</th><th class="num">VALOR TOTAL</th></tr>
          ${s.cats.map(([cat, itens]) => `<tr class="med-cat"><td colspan="6">${esc(cat)}</td></tr>
            ${itens.map((i) => `<tr><td>${++n}</td><td>${esc(i.cod)}</td><td>${esc(i.desc)}</td>
              <td class="num">${M.fmtQtd(i.qtd)}</td><td class="num">${M.fmtNum(i.us)}</td><td class="num">${M.fmtMoeda(i.valor)}</td></tr>`).join("")}`).join("")}
          <tr class="med-total"><td colspan="4">TOTAL ${esc(s.op)}</td><td class="num">${M.fmtNum(s.subtotalUs)}</td><td class="num">${M.fmtMoeda(s.subtotal)}</td></tr>`;
      }).join("");
      return `<article class="ponto">
        <div class="ponto-topo"><b>${esc(p.nome)}</b>
          ${p.gps ? `<span>${esc(M.fmtUtm(p.gps))}</span>` : ""}
          <span class="espaco"></span>
          <span>${p.itens.length} ${p.itens.length === 1 ? "serviço" : "serviços"} · ${M.fmtNum(tp.us)} US · <b>${M.fmtMoeda(tp.valor)}</b></span>
        </div>
        ${p.obs ? `<p class="ponto-obs">Obs.: ${esc(p.obs)}</p>` : ""}
        ${p.itens.length ? `<div class="med-rola"><table class="med"><tbody>${tabela}
          <tr class="med-total"><td colspan="4">TOTAL ${esc(p.nome)}</td><td class="num">${M.fmtNum(tp.us)}</td><td class="num">${M.fmtMoeda(tp.valor)}</td></tr>
        </tbody></table></div>` : `<p class="sem">Sem serviços lançados.</p>`}
        ${p.fotos.length ? `<div class="fotos">${p.fotos.map((fid) => `<button type="button" class="foto" data-foto="${fid}" data-ver="${fid}">${estado.fotos.has(fid) ? `<img src="${estado.fotos.get(fid)}" alt="Foto ${esc(p.nome)}">` : "carregando…"}</button>`).join("")}</div>`
          : `<p class="sem">Sem fotos.</p>`}
      </article>`;
    }).join("");
    return `<div class="fundo" data-acao="fechar">
      <aside class="gaveta" data-parar>
        <div class="gaveta-topo"><h2>Obra ${esc(o.numero)}</h2><span class="espaco"></span>
          <span>${M.fmtMoeda(t.valor)} · ${M.fmtNum(t.us)} US</span>
          <button type="button" class="fechar" data-acao="fechar" aria-label="Fechar">×</button></div>
        <div class="gaveta-corpo">
          <div class="info">
            <span>Cidade: <b>${esc(o.municipio || "—")}</b></span>
            <span>Supervisor: <b>${esc(o.supervisor_nome || "—")}</b></span>
            <span>Pontos: <b>${M.pontosReais(o.pontos).length}</b></span>
            <span>Data de execução: <b>${dias.length ? M.fmtDia(dias[dias.length - 1]) : "—"}</b></span>
            <span>Alterada em: <b>${M.fmtHora(o.atualizada_em)}</b></span>
          </div>
          ${o.obs ? `<p class="info">Obs.: ${esc(o.obs)}</p>` : ""}
          <div class="botoes">
            <button type="button" class="botao" data-gerar="pdf" data-id="${o.id}">📄 PDF com fotos</button>
            <button type="button" class="botao botao-claro" data-gerar="xlsx" data-id="${o.id}">📊 Planilha Excel</button>
            <button type="button" class="botao botao-claro" data-gerar="pdf-sem" data-id="${o.id}">📄 PDF sem fotos</button>
          </div>
          ${secoes ? `<div class="secoes">${secoes}</div>` : ""}
          ${pontos || `<p class="sem">Nenhum ponto.</p>`}
        </div>
      </aside>
    </div>`;
  }

  function render() {
    if (!Nuvem.lerSessao() || !estado.perfil) {
      $p.innerHTML = telaEntrar();
      return;
    }
    const busca = document.activeElement?.id === "f-busca" ? document.activeElement.selectionStart : null;
    const rolagem = document.querySelector(".gaveta")?.scrollTop;
    // não refaz a tela enquanto o administrador digita no formulário de usuário
    if (document.activeElement?.closest?.("#form-usuario, .nova-senha")) return;
    $p.innerHTML = telaPainel();
    if (busca != null) {
      const el = document.getElementById("f-busca");
      el.focus();
      el.setSelectionRange(busca, busca);
    }
    if (rolagem) document.querySelector(".gaveta").scrollTop = rolagem;
  }

  /** botão Sair: com obra deste aparelho que ainda não subiu para o banco, não sai (sairia do app também) */
  async function sairDaConta() {
    try {
      const pend = (await Banco.listarObras()).filter((o) => o.pendente && o.dono !== false).length;
      if (pend) {
        alert(`${pend === 1 ? "1 obra lançada neste aparelho ainda não subiu" : `${pend} obras lançadas neste aparelho ainda não subiram`} para o banco. Abra o app com internet até aparecer "Tudo salvo no banco" e saia depois.`);
        return;
      }
    } catch (e) { /* sem banco do aparelho: sai */ }
    try { await Banco.gravar("perfil", null); } catch (e) { /* segue */ }
    sair();
  }

  function sair() {
    Nuvem.sair();
    estado.perfil = null;
    estado.obras = null;
    estado.aberta = null;
    estado.usuarios = null;
    render();
  }

  // ------------------------------------------------------------------ eventos
  $p.addEventListener("click", (e) => {
    const aba = e.target.closest("[data-aba]");
    if (aba) {
      estado.aba = aba.dataset.aba;
      try { localStorage.setItem("painel_aba", estado.aba); } catch (err) { /* sem espaço */ }
      render();
      if (estado.aba === "ajustes") abrindoAjustes();
      return;
    }
    const pj = e.target.closest("[data-projeto]");
    if (pj) return arquivoProjeto(pj.dataset.id, pj.dataset.projeto);
    const vo = e.target.closest("[data-abrir-obra]");
    if (vo) return abrir(vo.dataset.abrirObra);
    const g = e.target.closest("[data-gerar]");
    if (g) {
      e.stopPropagation();
      return gerar(g.dataset.gerar, g.dataset.id);
    }
    const ver = e.target.closest("[data-ver]");
    if (ver && estado.fotos.has(ver.dataset.ver)) {
      const v = document.createElement("div");
      v.className = "visor";
      v.innerHTML = `<img src="${estado.fotos.get(ver.dataset.ver)}" alt="Foto">`;
      v.addEventListener("click", () => v.remove());
      document.body.appendChild(v);
      return;
    }
    const ordem = e.target.closest("[data-ordem]");
    if (ordem) {
      const c = ordem.dataset.ordem;
      estado.ordem = { campo: c, desc: estado.ordem.campo === c ? !estado.ordem.desc : true };
      return render();
    }
    const linha = e.target.closest("[data-abrir]");
    if (linha) return abrir(linha.dataset.abrir);
    const acao = e.target.closest("[data-acao]");
    if (!acao) return;
    if (acao.dataset.acao === "fechar" && e.target.closest("[data-parar]") && !e.target.closest(".fechar")) return;
    switch (acao.dataset.acao) {
      case "fechar":
        estado.aberta = null;
        return render();
      case "sair": return sairDaConta();
      case "procurar-versao": return procurarVersao(true);
      case "atualizar-app": return atualizarApp();
      case "abrir-senha":
        estado.senhaDe = acao.dataset.id;
        render();
        return document.getElementById("nova-senha")?.focus();
      case "cancelar-senha":
        estado.senhaDe = null;
        return render();
      case "atualizar": return carregar(true);
      case "limpar":
        estado.filtro = { busca: "", supervisor: "", cidade: "", de: "", ate: "" };
        return render();
      default:
    }
  });

  // nome, ativo e administrador de cada usuário
  $p.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.acao === "copia-fotos") {
      try { localStorage.setItem("croqui_copia_fotos", t.checked ? "sim" : "nao"); } catch (err) { /* sem espaço */ }
      return avisar(t.checked ? "Cada foto tirada no app vai ganhar uma cópia no celular." : "Cópia no celular desligada.");
    }
    const id = t.dataset.uNome || t.dataset.uAtivo || t.dataset.uAdmin;
    if (!id) return;
    const campos = t.dataset.uNome ? { nome: t.value.trim().toUpperCase() } : t.dataset.uAtivo ? { ativo: t.checked } : { admin: t.checked };
    if (campos.nome === "") return avisar("O nome não pode ficar vazio.", "erro");
    try {
      await Nuvem.alterarSupervisor(id, campos);
      const u = estado.usuarios.find((x) => x.user_id === id);
      Object.assign(u, campos);
      avisar(t.dataset.uAtivo ? (t.checked ? "Acesso liberado." : "Acesso desativado.") : t.dataset.uAdmin ? "Nível de acesso alterado." : "Nome alterado.");
      t.blur();
      render();
      carregar(); // o nome do supervisor aparece nas obras
    } catch (err) {
      avisar(traduzir(err), "erro");
      carregarUsuarios();
    }
  });

  $p.addEventListener("input", (e) => {
    const mapa = { "f-busca": "busca", "f-supervisor": "supervisor", "f-cidade": "cidade", "f-de": "de", "f-ate": "ate" };
    const campo = mapa[e.target.id];
    if (!campo) return;
    estado.filtro[campo] = e.target.value;
    render();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const v = document.querySelector(".visor");
    if (v) return v.remove();
    if (estado.aberta) { estado.aberta = null; render(); }
  });

  $p.addEventListener("submit", async (e) => {
    if (e.target.id === "form-usuario") {
      e.preventDefault();
      const bt = document.getElementById("bt-usuario");
      bt.disabled = true;
      bt.textContent = "Criando…";
      const nome = document.getElementById("u-nome").value.trim();
      try {
        await Nuvem.criarUsuario(document.getElementById("u-email").value.trim(), document.getElementById("u-senha").value, nome,
          document.getElementById("u-admin").checked);
        avisar(`Usuário ${nome.toUpperCase()} criado. Já pode entrar no app.`);
        document.activeElement?.blur();
        return carregarUsuarios();
      } catch (err) {
        avisar(traduzir(err), "erro");
        bt.disabled = false;
        bt.textContent = "Criar usuário";
      }
      return;
    }
    if (e.target.dataset.senha) {
      e.preventDefault();
      try {
        await Nuvem.trocarSenha(e.target.dataset.senha, document.getElementById("nova-senha").value);
        estado.senhaDe = null;
        document.activeElement?.blur();
        avisar("Senha trocada.");
        render();
      } catch (err) {
        avisar(traduzir(err), "erro");
      }
      return;
    }
    if (e.target.id !== "form-entrar") return;
    e.preventDefault();
    const bt = document.getElementById("bt-entrar");
    const erro = document.getElementById("erro-entrar");
    bt.disabled = true;
    bt.textContent = "Entrando…";
    erro.hidden = true;
    try {
      estado.perfil = await Nuvem.entrar(document.getElementById("e-email").value.trim(), document.getElementById("e-senha").value);
      render();
      carregar();
    } catch (err) {
      erro.textContent = err.status === 0 ? "Sem conexão com o banco." : err.message;
      erro.hidden = false;
      bt.disabled = false;
      bt.textContent = "Entrar";
    }
  });

  async function iniciar() {
    if (!Nuvem.lerSessao()) return render();
    try {
      estado.perfil = await Nuvem.meuPerfil();
      if (!estado.perfil || !estado.perfil.ativo) return sair();
    } catch (e) {
      if (e.status === 401) return sair();
      estado.perfil = await Banco.ler("perfil");
      if (!estado.perfil) return sair();
    }
    render();
    carregar();
    if (estado.aba === "ajustes") abrindoAjustes();
    procurarVersao();
  }
  /** aba Ajustes aberta: usuários (administrador) e o espaço deste aparelho */
  function abrindoAjustes() {
    if (estado.perfil?.admin && estado.usuarios === null) carregarUsuarios();
    medirEspaco();
  }
  iniciar();
})();
