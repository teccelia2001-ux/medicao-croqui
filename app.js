/* Medição por Croqui: o supervisor anexa o projeto da obra (PDF ou imagem), abre o
   croqui, toca no poste e lança ali os serviços feitos (P1, P2...) com os códigos e
   valores do Termômetro e as fotos. Tocando num ponto já lançado, vê o que foi feito
   nele sem sair do croqui. No fim gera a medição (Excel e PDF, com o croqui e os
   pontos marcados) no padrão do fechamento do Termômetro.
   Base: o app Medição de Campo. Funciona sem internet: tudo fica guardado no celular. */
(function () {
  const M = window.Medicao;
  const ROTULO = { INSTALAR: "Instalar", RETIRAR: "Retirar", EXECUTAR: "Executar" };
  const SECAO = { INSTALAR: "Instalados", RETIRAR: "Retirados", EXECUTAR: "Executados" };
  const MAX_RESULTADOS = 40;
  const FOTO_MAX = 1600;

  const $app = document.getElementById("app");
  const $aviso = document.getElementById("aviso");

  // ------------------------------------------------------------------ util
  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const novoId = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const dataLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const hoje = () => dataLocal(new Date());
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const normalizar = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const obraValida = (n) => /^(\d{8}|\d{10})$/.test(n || "");

  let tempoAviso = null;
  function avisar(texto, tipo = "ok", ms = 3500) {
    $aviso.textContent = texto;
    $aviso.className = `aviso aviso-${tipo}`;
    $aviso.hidden = false;
    clearTimeout(tempoAviso);
    tempoAviso = setTimeout(() => ($aviso.hidden = true), ms);
  }

  // ------------------------------------------------------------------ estado
  const estado = {
    tela: "inicio", // inicio | obra-form | croqui | obra | ponto | medicao | config
    obras: [],
    obra: null,
    pontoId: null,
    busca: "",
    escolhido: null, // {codigo, descricao, opcoes}
    qtd: "",
    foto: null, // {id, url}
    arquivo: null, // {nome, blob}
    gerando: false,
    miniaturas: new Map(), // fotoId -> objectURL
    perfil: null, // linha de medicao_supervisores
    remotas: null, // obras do banco (medicao_obras_lista)
    filtro: "minhas", // minhas | todas
    enviando: false,
    online: navigator.onLine,
    supervisores: null, // ajustes do administrador
    // croqui
    cqPag: 1, // folha do projeto aberta
    cqSel: null, // ponto escolhido no croqui (mostra o que foi feito nele)
    cqNovo: null, // toque num lugar vazio: { pag, x, y, nome } (pergunta se cria o ponto ali)
    cqMover: null, // id do ponto que vai para o próximo lugar tocado
    cqCentrar: null, // id do ponto para pôr no meio da tela ao abrir
    projetoNovo: null, // arquivo escolhido na tela da obra: { blob, nome, tipo }
    ordemPontos: (() => { try { return localStorage.getItem("croqui_ordem_pontos") === "decr" ? "decr" : "cresc"; } catch (e) { return "cresc"; } })(),
  };
  /** P1, P2 ... P10 na ordem certa (número por número, não letra por letra) */
  const cmpPonto = (a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR", { numeric: true, sensitivity: "base" });
  const ponto = () => estado.obra?.pontos.find((p) => p.id === estado.pontoId);
  // tablet e computador: o lançamento do ponto abre ao lado, com o croqui à vista (18/11/2026)
  const TELA_LARGA = matchMedia("(min-width: 760px)");
  const painelLateral = () => TELA_LARGA.matches;
  /** a tela do ponto está à vista (sozinha, ou no painel ao lado do croqui) */
  const vendoPonto = () => estado.tela === "ponto" || (estado.tela === "croqui" && !!estado.cqPainel);
  /** abre o ponto: no croqui de tablet/computador, no painel ao lado; senão, na tela dele */
  function abrirPonto(id) {
    if (painelLateral() && estado.tela === "croqui" && estado.obra?.projeto) {
      return irPara("croqui", { cqPainel: id, pontoId: id, cqSel: id, cqNovo: null, cqNota: null });
    }
    return irPara("ponto", { pontoId: id });
  }
  /** obra de outro supervisor: abre só para consulta e para gerar a medição */
  const soLeitura = (o) => o && o.dono === false;

  let tempoSalvar = null;
  let vaiSalvar = false; // tem alteração esperando os 400 ms para ser guardada
  function salvarDepois() {
    clearTimeout(tempoSalvar);
    vaiSalvar = true;
    tempoSalvar = setTimeout(salvarAgora, 400);
  }
  async function salvarAgora() {
    clearTimeout(tempoSalvar);
    vaiSalvar = false;
    // obra nova só existe depois do botão "Criar obra"
    if (!estado.obra || soLeitura(estado.obra) || !estado.obra.criada_em) return;
    if ((await obrasExcluidas()).has(estado.obra.id)) return;
    try {
      estado.obra.dono = true;
      await Banco.salvarObra(estado.obra);
      enviarDepois();
    } catch (e) {
      avisar("Não foi possível guardar no celular. Libere espaço.", "erro");
    }
  }

  async function irPara(tela, extra = {}) {
    const saindo = estado.tela === "ponto" ? ponto() : null;
    if (saindo?.geral && !saindo.itens.length && !saindo.fotos.length && !saindo.obs && (extra.pontoId !== saindo.id)) {
      estado.obra.pontos = estado.obra.pontos.filter((x) => x !== saindo);
    }
    await salvarAgora();
    // outro ponto (ou outra tela): a pesquisa dos serviços lançados começa limpa
    if (tela !== "ponto" || extra.pontoId !== estado.pontoId) estado.filtroItens = "";
    if (tela !== "croqui") { estado.cqNovo = null; estado.cqNota = null; estado.cqDesenho = false; estado.cqAjuste = null; estado.cqPainel = null; if (!("cqMover" in extra)) estado.cqMover = null; }
    Object.assign(estado, { tela, busca: "", escolhido: null, qtd: "", arquivo: null }, extra);
    if (tela !== "obra-form") estado.projetoNovo = null;
    if (tela === "inicio") {
      await recarregarLocais();
      estado.obra = null;
      Object.assign(estado, { cqSel: null, cqNovo: null, cqMover: null, cqPag: 1 });
      liberarMiniaturas();
      if (Date.now() - (estado.remotasEm || 0) > 20000) buscarRemotas();
    }
    render();
    window.scrollTo(0, 0);
  }
  async function recarregarLocais() {
    estado.obras = (await Banco.listarObras()).sort((a, b) => (b.atualizada_em || "").localeCompare(a.atualizada_em || ""));
  }

  function liberarMiniaturas() {
    estado.miniaturas.forEach((u) => URL.revokeObjectURL(u));
    estado.miniaturas.clear();
  }
  /** Foto do aparelho; se ela só existe no banco (obra aberta de lá), baixa e guarda. */
  async function fotoLocal(obra, id) {
    const f = await Banco.obterFoto(id);
    const info = obra.fotos_info?.[id] || {};
    // guardada com a faixa antiga (refeita em outro aparelho): baixa de novo
    const velha = f && f.enviada && info.faixa_em && f.faixa_em !== info.faixa_em;
    if (f && !velha) return f;
    if (!navigator.onLine || !Nuvem.lerSessao()) return f || null;
    try {
      const blob = await Nuvem.baixarFoto(obra.id, id);
      const p = obra.pontos.find((x) => x.fotos.includes(id));
      const nova = { ...(f || {}), id, obraId: obra.id, pontoId: p?.id || info.pontoId, blob, enviada: true, criada_em: info.criada_em, gps: info.gps, largura: info.largura, altura: info.altura, faixa_em: info.faixa_em || null };
      delete nova.faixa; // não se sabe o texto exato da faixa baixada
      await Banco.salvarFoto(nova);
      return nova;
    } catch (e) {
      return f || null;
    }
  }
  const carregando = new Set();
  async function carregarMiniaturas(ids) {
    const faltam = ids.filter((id) => !estado.miniaturas.has(id) && !carregando.has(id));
    if (!faltam.length) return;
    const obra = estado.obra;
    faltam.forEach((id) => carregando.add(id));
    for (const id of faltam) {
      const f = await fotoLocal(obra, id);
      if (f) estado.miniaturas.set(id, URL.createObjectURL(f.blob));
    }
    faltam.forEach((id) => carregando.delete(id));
    if (estado.obra === obra && (vendoPonto() || (estado.tela === "croqui" && estado.cqSel))) render();
  }

  // ------------------------------------------------------------------ envio ao banco
  let tempoEnvio = null;
  function enviarDepois(ms = 1200) {
    clearTimeout(tempoEnvio);
    tempoEnvio = setTimeout(enviarPendentes, ms);
  }
  /** Obras excluídas neste aparelho (guardado para sempre, até 1000): nada as grava ou
   *  envia de novo — nem a análise do projeto que ainda estava rodando, nem outra cópia que
   *  apareça no banco (ela é apagada de novo). */
  let excluidas = null;
  async function obrasExcluidas() {
    if (!excluidas) excluidas = new Set(await Banco.ler("excluidas", []));
    return excluidas;
  }
  async function marcarExcluida(id) {
    const ex = await obrasExcluidas();
    ex.add(id);
    await Banco.gravar("excluidas", [...ex].slice(-1000));
  }

  /** Manda ao banco as obras alteradas e as exclusões guardadas. Sem sinal, espera. */
  async function enviarPendentes() {
    clearTimeout(tempoEnvio);
    if (estado.enviando || !navigator.onLine || !Nuvem.lerSessao()) return;
    estado.enviando = true;
    atualizarSelo();
    let semRede = false;
    try {
      const exclusoes = await Banco.ler("exclusoes", []);
      for (const id of [...exclusoes]) {
        try {
          // a obra sai do banco, mas as fotos dela ficam: sobe antes as que faltam
          await Nuvem.enviarFotos(id);
          await Nuvem.apagarObra(id);
          exclusoes.splice(exclusoes.indexOf(id), 1);
          await Banco.gravar("exclusoes", exclusoes);
        } catch (e) {
          if (e.status === 0) throw e;
        }
      }
      const meu = estado.perfil?.user_id;
      const ex = await obrasExcluidas();
      const obras = (await Banco.listarObras()).filter((o) => o.pendente && o.dono !== false && o.criada_em && (!o.dono_id || o.dono_id === meu) && !ex.has(o.id));
      for (const o of obras) {
        try {
          await Nuvem.enviarObra(o, M.totaisObra(o));
        } catch (e) {
          if (e.status === 0) throw e; // caiu o sinal: tenta tudo depois
          if (e.status === 401) { avisar("Sua sessão expirou. Entre de novo.", "erro"); return sairDaConta(true); }
          const atual = await Banco.obterObra(o.id);
          if (atual) { atual.erro_envio = e.message; await Banco.salvarObra(atual, { envio: true }); }
        }
      }
    } catch (e) {
      semRede = true; // sem sinal: tenta de novo quando voltar
    } finally {
      estado.enviando = false;
    }
    // mudou algo enquanto subia? manda de novo logo em seguida
    if (!semRede) {
      const meu = estado.perfil?.user_id;
      const falta = (await Banco.listarObras()).some((o) => o.pendente && !o.erro_envio && o.dono !== false && o.criada_em && (!o.dono_id || o.dono_id === meu));
      if (falta) enviarDepois(800);
    }
    // atualiza o que está na tela sem perder o que o supervisor digita
    if (estado.obra) {
      const atual = await Banco.obterObra(estado.obra.id);
      if (atual && atual.atualizada_em === estado.obra.atualizada_em) {
        Object.assign(estado.obra, { pendente: atual.pendente, enviada_em: atual.enviada_em, erro_envio: atual.erro_envio, fotos_info: atual.fotos_info });
      }
    }
    if (estado.tela === "inicio") { await recarregarLocais(); render(); }
    atualizarSelo();
  }

  function seloHtml(o) {
    if (!o) return "";
    if (soLeitura(o)) return `<span class="selo selo-consulta">Consulta</span>`;
    if (o.erro_envio) return `<span class="selo selo-erro" title="${esc(o.erro_envio)}">⚠ Não enviada</span>`;
    if (o.pendente) return `<span class="selo selo-pendente">${estado.enviando ? "⟳ Enviando…" : "⏳ Aguardando envio"}</span>`;
    return `<span class="selo selo-ok">✓ No banco</span>`;
  }
  function atualizarSelo() {
    const el = document.getElementById("selo-obra");
    if (el && estado.obra) el.innerHTML = seloHtml(estado.obra);
  }

  // ------------------------------------------------------------------ obras do banco
  async function buscarRemotas(avisando = false) {
    if (!navigator.onLine || !Nuvem.lerSessao()) return;
    try {
      // obra excluída que ainda não saiu do banco (sem sinal na hora) não volta para a lista
      const saindo = new Set(await Banco.ler("exclusoes", []));
      const ex = await obrasExcluidas();
      const pedidaEm = Date.now();
      const tudo = await Nuvem.listarObras();
      // excluída aqui que reapareceu no banco (outra cópia subiu depois): apaga de novo
      const voltaram = tudo.filter((r) => ex.has(r.id) && !saindo.has(r.id) && r.supervisor_id === estado.perfil?.user_id);
      if (voltaram.length) {
        const exclusoes = await Banco.ler("exclusoes", []);
        voltaram.forEach((r) => { if (!exclusoes.includes(r.id)) exclusoes.push(r.id); });
        await Banco.gravar("exclusoes", exclusoes);
        enviarDepois(500);
      }
      const lista = tudo.filter((r) => !saindo.has(r.id) && !ex.has(r.id));
      estado.remotas = lista;
      estado.remotasEm = Date.now();
      // obra que já estava no banco e sumiu de lá (excluída em outro aparelho): sai deste
      // também. Só a que não tem nada para enviar, e só com a lista inteira em mãos
      if (tudo.length < 500) {
        const noBanco = new Set(tudo.map((r) => r.id));
        for (const o of await Banco.listarObras()) {
          // no banco desde antes de pedir a lista (a que acabou de subir pode ainda não constar)
          const antiga = o.enviada_em && new Date(o.enviada_em).getTime() < pedidaEm - 60000;
          if (!o.pendente && antiga && !noBanco.has(o.id) && estado.obra?.id !== o.id) await Banco.excluirObra(o.id);
        }
      }
      // obra parada no aparelho e mais nova no banco: traz a versão do banco (alterada em outro
      // aparelho). A obra aberta só troca se ninguém está mexendo nela agora
      let trocouAberta = null;
      for (const r of lista) {
        const local = await Banco.obterObra(r.id);
        if (local && !local.pendente && r.atualizada_em && new Date(r.atualizada_em) > new Date(local.atualizada_em)) {
          const aberta = estado.obra?.id === r.id;
          if (aberta && !podeTrocarAberta()) continue; // fica para a próxima busca
          await trazerObra(r.id);
          if (aberta) trocouAberta = r.id;
        }
      }
      if (trocouAberta && estado.obra?.id === trocouAberta && podeTrocarAberta()) {
        const nova = await Banco.obterObra(trocouAberta);
        if (nova) {
          estado.obra = nova;
          render();
          avisar("Obra atualizada com o que foi feito em outro aparelho.", "guardado");
        }
      }
      if (estado.tela === "inicio") { await recarregarLocais(); render(); }
      if (avisando) avisar("Lista atualizada.");
    } catch (e) {
      if (avisando) avisar(e.message, "erro");
    }
  }

  /** a obra aberta pode ser trocada pela do banco: nada esperando para salvar ou enviar, e o
   *  supervisor não está digitando nem no meio de um toque, ajuste ou rascunho */
  function podeTrocarAberta() {
    const o = estado.obra;
    if (!o || vaiSalvar || o.pendente) return false;
    if (document.activeElement?.matches?.("input, textarea, select")) return false;
    return !(estado.escolhido || estado.cqNovo || estado.cqNota || estado.cqAjuste || estado.cqDesenho || estado.cqMover || estado.gerando);
  }

  async function trazerObra(id) {
    const r = await Nuvem.baixarObra(id);
    if (!r) throw new Error("A obra não está mais no banco.");
    const dono = r.supervisor_id === estado.perfil?.user_id;
    const remota = estado.remotas?.find((x) => x.id === id);
    const obra = {
      id: r.id, numero: r.numero, local: r.local || "", municipio: r.municipio || "", departamento: r.departamento,
      equipe: r.equipe || "", obs: r.obs || "", pontos: r.pontos || [], fotos_info: r.fotos || {}, projeto: r.projeto ? (({ anotacoes, rotulos, ...resto }) => resto)(r.projeto) : null, anotacoes: r.projeto?.anotacoes || null, rotulos: r.projeto?.rotulos || null,
      criada_em: r.criada_em, atualizada_em: r.atualizada_em, pendente: false, enviada_em: r.recebida_em,
      dono, dono_id: r.supervisor_id, supervisor_nome: remota?.supervisor_nome || null,
    };
    await Banco.salvarObra(obra, { envio: true });
    return obra;
  }

  // ------------------------------------------------------------------ render
  // tela que estava desenhada: refazendo a mesma (lançou um serviço, abriu a quantidade...)
  // a rolagem fica onde estava, na página e em cada coluna (no computador cada uma rola sozinha)
  let desenhada = { tela: null, ponto: null };
  const ROLAM = ".ponto-col, .medicao-col, .cq-painel";

  function render() {
    const telas = { entrar: telaEntrar, carregando: telaCarregando, inicio: telaInicio, "obra-form": telaObraForm, croqui: telaCroqui, obra: telaObra, ponto: telaPonto, medicao: telaMedicao, config: telaConfig };
    const mesma = desenhada.tela === estado.tela && desenhada.ponto === estado.pontoId;
    const colunas = mesma ? [...$app.querySelectorAll(ROLAM)].map((c) => c.scrollTop) : null;
    const pagina = window.scrollY;
    $app.innerHTML = telas[estado.tela]();
    if (colunas) {
      $app.querySelectorAll(ROLAM).forEach((c, i) => { if (colunas[i]) c.scrollTop = colunas[i]; });
      if (window.scrollY !== pagina) window.scrollTo(0, pagina);
    }
    desenhada = { tela: estado.tela, ponto: estado.pontoId };
    document.body.classList.toggle("com-croqui", estado.tela === "croqui");
    if (estado.tela === "croqui") { montarCroqui(); acimaDaBarra(); }
    if (vendoPonto()) {
      const p = ponto();
      if (p) carregarMiniaturas(p.fotos);
      // na mesma hora do toque: assim o celular abre o teclado
      if (estado.escolhido) document.getElementById("qtd-folha")?.focus({ preventScroll: true });
      if (estado.foto) ligarVisor();
    }
  }

  /** visor: abre na foto escolhida e acompanha o dedo (a faixa de fotos rola de lado) */
  function ligarVisor() {
    const faixa = document.getElementById("visor-fotos");
    if (!faixa) return;
    const ids = ponto()?.fotos?.length ? ponto().fotos : [estado.foto.id];
    const posicionar = () => { faixa.scrollLeft = Math.max(0, ids.indexOf(estado.foto?.id)) * faixa.clientWidth; };
    posicionar();
    let quadro = 0;
    faixa.addEventListener("scroll", () => {
      cancelAnimationFrame(quadro);
      quadro = requestAnimationFrame(() => {
        const i = Math.min(ids.length - 1, Math.max(0, Math.round(faixa.scrollLeft / faixa.clientWidth)));
        if (!estado.foto || ids[i] === estado.foto.id) return;
        estado.foto = { id: ids[i] };
        const cont = document.getElementById("visor-cont");
        if (cont) cont.textContent = `${i + 1} de ${ids.length}`;
      });
    }, { passive: true });
    faixa.dataset.posicionar = "1";
    faixa.posicionar = posicionar;
    ligarZoomVisor(faixa, ids);
  }

  /* Zoom na foto aberta: pinça com dois dedos, toque duplo (aproxima onde tocou / volta) e,
     aproximada, um dedo arrasta. No computador: rodinha do mouse, clique duplo e arrastar.
     Com a foto aproximada a faixa não rola de lado; volta a rolar quando a foto volta ao normal. */
  function ligarZoomVisor(faixa, ids) {
    const ZMAX = 6;
    let z = 1, tx = 0, ty = 0;
    let gesto = null, toqueAnt = null, arrasto = null;
    const imgAtual = () => faixa.children[Math.max(0, ids.indexOf(estado.foto?.id))]?.querySelector("img");
    const caixa = () => faixa.getBoundingClientRect();
    // ponto relativo ao centro da foto
    const rel = (x, y) => { const r = caixa(); return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 }; };
    function limitar() {
      const img = imgAtual(), r = caixa();
      if (!img) return;
      // tamanho da imagem de verdade dentro do quadro (object-fit: contain)
      const prop = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : r.width / r.height;
      const w = Math.min(r.width, r.height * prop), h = Math.min(r.height, r.width / prop);
      const mx = Math.max(0, (w * z - r.width) / 2), my = Math.max(0, (h * z - r.height) / 2);
      tx = Math.min(mx, Math.max(-mx, tx));
      ty = Math.min(my, Math.max(-my, ty));
    }
    function aplicar(animar = false) {
      const img = imgAtual();
      if (!img) return;
      if (z <= 1.01) { z = 1; tx = 0; ty = 0; }
      limitar();
      img.style.transition = animar ? "transform .2s ease-out" : "none";
      img.style.transform = z > 1 ? `translate(${tx}px, ${ty}px) scale(${z})` : "";
      faixa.classList.toggle("visor-zoom", z > 1);
    }
    function zoomEm(novo, p, base = { z, tx, ty }, animar = false) {
      // mantém parado o ponto da foto que está embaixo do dedo (ou do mouse)
      const nz = Math.min(ZMAX, Math.max(1, novo));
      tx = p.x - (p.x - base.tx) * (nz / base.z);
      ty = p.y - (p.y - base.ty) * (nz / base.z);
      z = nz;
      aplicar(animar);
    }
    function alternar(p) { if (z > 1) { z = 1; aplicar(true); } else zoomEm(2.5, p, { z: 1, tx: 0, ty: 0 }, true); }
    faixa.zerarZoom = () => { if (z > 1) { z = 1; aplicar(); } };

    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const meio = (a, b) => rel((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    faixa.addEventListener("touchstart", (e) => {
      const t = e.touches;
      if (t.length === 2) {
        gesto = { tipo: "pinca", d0: dist(t[0], t[1]), m0: meio(t[0], t[1]), z0: z, tx0: tx, ty0: ty };
        toqueAnt = null;
      } else if (t.length === 1) {
        gesto = z > 1 ? { tipo: "arrasto", x0: t[0].clientX, y0: t[0].clientY, tx0: tx, ty0: ty } : null;
        // toque duplo
        const agora = Date.now(), p = { x: t[0].clientX, y: t[0].clientY };
        if (toqueAnt && agora - toqueAnt.em < 320 && Math.hypot(p.x - toqueAnt.x, p.y - toqueAnt.y) < 40) {
          e.preventDefault();
          alternar(rel(p.x, p.y));
          toqueAnt = null;
          gesto = null;
        } else toqueAnt = { ...p, em: agora };
      }
    }, { passive: false });
    faixa.addEventListener("touchmove", (e) => {
      const t = e.touches;
      if (gesto?.tipo === "pinca" && t.length === 2) {
        e.preventDefault();
        const m = meio(t[0], t[1]);
        const nz = Math.min(ZMAX, Math.max(1, gesto.z0 * (dist(t[0], t[1]) / gesto.d0)));
        // aproxima em volta do meio dos dedos e acompanha os dedos andando
        tx = m.x - (gesto.m0.x - gesto.tx0) * (nz / gesto.z0);
        ty = m.y - (gesto.m0.y - gesto.ty0) * (nz / gesto.z0);
        z = nz;
        aplicar();
      } else if (gesto?.tipo === "arrasto" && t.length === 1) {
        e.preventDefault();
        tx = gesto.tx0 + t[0].clientX - gesto.x0;
        ty = gesto.ty0 + t[0].clientY - gesto.y0;
        aplicar();
        toqueAnt = null;
      }
    }, { passive: false });
    faixa.addEventListener("touchend", (e) => {
      if (e.touches.length === 1 && z > 1) {
        // tirou um dos dois dedos: segue arrastando com o que ficou
        const t = e.touches[0];
        gesto = { tipo: "arrasto", x0: t.clientX, y0: t.clientY, tx0: tx, ty0: ty };
      } else if (!e.touches.length) gesto = null;
    }, { passive: true });

    // computador
    faixa.addEventListener("wheel", (e) => {
      e.preventDefault();
      zoomEm(z * Math.exp(-e.deltaY * 0.0015), rel(e.clientX, e.clientY));
    }, { passive: false });
    faixa.addEventListener("dblclick", (e) => { if (!e.sourceCapabilities?.firesTouchEvents) alternar(rel(e.clientX, e.clientY)); });
    faixa.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || z <= 1) return;
      arrasto = { x0: e.clientX, y0: e.clientY, tx0: tx, ty0: ty };
      faixa.setPointerCapture(e.pointerId);
    });
    faixa.addEventListener("pointermove", (e) => {
      if (!arrasto) return;
      tx = arrasto.tx0 + e.clientX - arrasto.x0;
      ty = arrasto.ty0 + e.clientY - arrasto.y0;
      aplicar();
    });
    const soltar = () => { arrasto = null; };
    faixa.addEventListener("pointerup", soltar);
    faixa.addEventListener("pointercancel", soltar);
  }
  // girou o celular: continua na mesma foto
  window.addEventListener("resize", () => document.getElementById("visor-fotos")?.posicionar?.());
  function andarFoto(passo) {
    const faixa = document.getElementById("visor-fotos");
    faixa?.zerarZoom?.();
    if (faixa) faixa.scrollBy({ left: passo * faixa.clientWidth, behavior: "smooth" });
  }

  function topo(titulo, voltar, direita = "") {
    return `<header class="topo">
      ${voltar ? `<button type="button" class="voltar" data-acao="${voltar}">‹ Voltar</button>` : `<img src="logo-teccel-red.png" alt="Teccel" class="topo-logo">`}
      <b>${esc(titulo)}</b>
      <span class="topo-dir">${direita}</span>
    </header>`;
  }

  // ---------- entrada
  function telaEntrar() {
    return `<div class="pagina pagina-entrar">
      <form class="cartao entrar" id="form-entrar">
        <img src="logo-teccel-red.png" alt="Teccel" class="logo-entrar">
        <h1>Medição por croqui</h1>
        <p class="sub centro">Entre com o seu acesso de supervisor.</p>
        ${!Nuvem.configurada() ? `<div class="erro">O endereço do banco ainda não foi configurado (config.js).</div>` : ""}
        <label class="campo">E-mail
          <input id="e-email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" required>
        </label>
        <label class="campo">Senha
          <input id="e-senha" type="password" autocomplete="current-password" required>
        </label>
        <div class="erro" id="erro-entrar" hidden></div>
        <button class="botao" id="bt-entrar">Entrar</button>
      </form>
    </div>`;
  }
  function telaCarregando() {
    return `<div class="pagina pagina-entrar"><p class="vazio centro">${esc(estado.carregandoTexto || "Carregando…")}</p></div>`;
  }

  // ---------- início
  /** Todas as obras do sistema numa lista só: as do celular e as que estão no banco.
   *  Tocar numa obra que ainda não está no celular abre direto (o app traz do banco). */
  function obrasDaLista() {
    const meu = estado.perfil?.user_id;
    const remotas = new Map((estado.remotas || []).map((r) => [r.id, r]));
    const lista = estado.obras.map((o) => {
      const r = remotas.get(o.id);
      const t = M.totaisObra(o);
      return {
        id: o.id, numero: o.numero, cidade: o.municipio || o.local || "", total: t.valor,
        pontos: M.pontosReais(o.pontos).length, fotos: o.pontos.reduce((n, p) => n + p.fotos.length, 0), croqui: !!o.projeto,
        atualizada_em: o.atualizada_em, supervisor: soLeitura(o) ? o.supervisor_nome || r?.supervisor_nome : estado.perfil?.nome,
        selo: seloHtml(o), meu: !soLeitura(o),
      };
    });
    const locais = new Set(estado.obras.map((o) => o.id));
    for (const r of remotas.values()) {
      if (locais.has(r.id)) continue;
      lista.push({
        id: r.id, numero: r.numero, cidade: r.municipio || r.local || "", total: Number(r.total), pontos: r.qtd_pontos,
        fotos: null, atualizada_em: r.atualizada_em, supervisor: r.supervisor_nome, meu: r.supervisor_id === meu,
        selo: r.supervisor_id === meu ? `<span class="selo selo-ok">✓ No banco</span>` : `<span class="selo selo-consulta">Consulta</span>`,
      });
    }
    return lista.sort((a, b) => (b.atualizada_em || "").localeCompare(a.atualizada_em || ""));
  }

  /** Exclui a obra do celular e põe na fila para sair do banco, depois de confirmar.
   *  Vale para a obra aberta e para a do cartão (mesmo a que só está no banco). */
  async function excluirObra(id, numero, pontos) {
    if (!confirm(`Excluir a obra ${numero}? Pontos e serviços serão apagados deste celular e do banco, e não dá para desfazer. As fotos continuam guardadas no celular e no banco.`)) return false;
    if (pontos && !confirm(`Tem certeza? A obra ${numero} tem ${plural(pontos, "ponto", "pontos")}. Se ainda não gerou a medição, os serviços lançados serão perdidos.`)) return false;
    await marcarExcluida(id);
    await Banco.excluirObra(id);
    // sempre entra na fila: além de tirar a obra do banco, sobe as fotos que faltam
    const exclusoes = await Banco.ler("exclusoes", []);
    if (!exclusoes.includes(id)) exclusoes.push(id);
    await Banco.gravar("exclusoes", exclusoes);
    estado.obras = estado.obras.filter((x) => x.id !== id);
    if (estado.remotas) estado.remotas = estado.remotas.filter((r) => r.id !== id);
    avisar("Obra excluída.");
    enviarDepois(500);
    return true;
  }

  function telaInicio() {
    const pendentes = estado.obras.filter((o) => o.pendente && !soLeitura(o)).length;
    const termos = normalizar(estado.filtroObra || "").split(/\s+/).filter(Boolean);
    const todas = obrasDaLista();
    const vistas = termos.length
      ? todas.filter((o) => termos.every((t) => normalizar(`${o.numero} ${o.cidade} ${o.supervisor || ""}`).includes(t)))
      : todas;
    const cartao = (o) => `<div class="obra-cartao${o.meu ? " com-lixo" : ""}"><button type="button" class="cartao obra-item" data-acao="abrir-obra" data-id="${o.id}">
        <div class="linha-topo"><span class="chip-obra"><small>OBRA</small><b>${esc(o.numero)}</b></span><b class="valor">${M.fmtMoeda(o.total)}</b></div>
        ${o.cidade ? `<p class="sub">${esc(o.cidade)}</p>` : ""}
        <small class="sub">${o.croqui ? "🗺 " : ""}${plural(o.pontos, "ponto", "pontos")}${o.fotos != null ? " · " + plural(o.fotos, "foto", "fotos") : ""}${o.supervisor ? " · " + esc(o.supervisor) : ""}</small>
        <div class="linha-topo">${o.selo}<small class="sub">alterada ${M.fmtHora(o.atualizada_em)}</small></div>
      </button>${o.meu ? `<button type="button" class="obra-lixo" data-acao="excluir-obra-lista" data-id="${o.id}" aria-label="Excluir a obra ${esc(o.numero)}" title="Excluir obra">🗑</button>` : ""}</div>`;
    return `<div class="pagina pagina-larga">
      ${topo("", null, `<nav class="troca" aria-label="Trocar entre app e painel"><span class="ativo">📱 App</span><a href="painel.html">📊 Painel</a></nav><button type="button" class="link link-ajustes${estado.novaVersao ? " novidade" : ""}" data-acao="config" aria-label="Ajustes">⚙<span> Ajustes</span></button>`)}
      ${!estado.online ? `<div class="faixa faixa-guardado">Sem internet: aparecem só as obras guardadas no celular. O que você lançar sobe para o banco quando o sinal voltar.</div>`
        : pendentes ? `<div class="faixa faixa-guardado">${estado.enviando ? "⟳ Enviando" : "⏳ Aguardando envio de"} ${plural(pendentes, "obra", "obras")} ao banco…</div>`
          : `<div class="faixa faixa-ok">✓ Tudo salvo no banco</div>`}
      ${estado.espacoApertado ? `<div class="erro">Espaço do celular quase cheio para o app. Libere espaço no celular apagando outros arquivos ou aplicativos (as fotos do app ficam guardadas).</div>` : ""}
      <div id="faixa-analise">${faixaAnalise()}</div>
      <button type="button" class="botao botao-grande" data-acao="nova-obra">+ Nova obra</button>
      ${instalarHtml()}
      <section class="bloco">
        <div class="linha-topo"><h2>Obras ${todas.length ? `<small class="sub-inline">(${todas.length})</small>` : ""}</h2>
          <button type="button" class="link" data-acao="atualizar-lista">⟳ Atualizar</button></div>
        ${todas.length > 3 ? `<label class="campo"><input id="filtro-obra" type="search" value="${esc(estado.filtroObra || "")}" placeholder="Buscar pelo número, cidade ou supervisor" autocomplete="off"></label>` : ""}
        <div id="lista-obras">${vistas.map(cartao).join("")
          || (termos.length ? `<p class="vazio">Nenhuma obra encontrada.</p>`
            : estado.remotas === null && estado.online ? `<p class="vazio">Carregando as obras do banco…</p>`
              : `<p class="vazio">Nenhuma obra ainda. Toque em <b>Nova obra</b> para começar.</p>`)}</div>
      </section>
    </div>`;
  }

  function instalarHtml() {
    const instalado = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (instalado || !/Android|iPhone|iPad/i.test(navigator.userAgent)) return "";
    const ios = /iPhone|iPad/i.test(navigator.userAgent);
    return `<div class="instalar"><button type="button" data-acao="instalar">📲 Instalar no celular</button>
      <p id="ajuda-instalar" hidden>${ios ? "No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início." : "No menu ⋮ do Chrome, toque em Instalar aplicativo ou Adicionar à tela inicial."}</p></div>`;
  }

  // ---------- ajustes
  function telaConfig() {
    const p = estado.perfil || {};
    const sups = estado.supervisores;
    return `<div class="pagina">
      ${topo("Ajustes", "inicio")}
      <section class="cartao dados">
        <b>Sua conta</b>
        <p class="sub">${esc(p.nome)} · ${esc(p.email)}${p.admin ? " · administrador" : ""}</p>
        <p class="sub">O nome que sai na medição é o do cadastro${p.admin ? "" : "; para corrigir, fale com o administrador"}.</p>
        <button type="button" class="botao botao-perigo" data-acao="sair">Sair da conta</button>
      </section>
      <section class="cartao dados">
        <b>Fotos</b>
        ${ehIos()
          ? `<p class="sub">No iPhone o app não consegue salvar sozinho na galeria. No ponto, toque em <b>💾 Salvar as fotos no celular</b> e escolha <b>Salvar imagens</b>.</p>`
          : `<label class="chave-linha"><input type="checkbox" data-acao="copia-fotos" ${copiaLigada() ? "checked" : ""}>
              <span>Salvar uma cópia de cada foto tirada no celular <small>(pasta Download, aparece na galeria)</small></span></label>`}
        <p class="sub">As fotos também ficam guardadas no app e sobem para o banco.</p>
      </section>
      <section class="cartao dados">
        <b>Versão do app</b>
        <p class="sub">Você está na <b>versão ${esc(versaoAtual().numero)}</b>${versaoAtual().data ? ` · de ${esc(versaoAtual().data)}` : ""}.</p>
        ${estado.novaVersao
          ? `<p class="versao-nova">Nova versão ${esc(estado.novaVersao.numero)} disponível${estado.novaVersao.data ? ` (${esc(estado.novaVersao.data)})` : ""}.</p>
            <button type="button" class="botao" data-acao="atualizar-app">⬇ Atualizar agora</button>
            <small class="sub">O que você lançou fica guardado; o app só recarrega.</small>`
          : `<button type="button" class="botao botao-claro" data-acao="procurar-versao">${estado.procurandoVersao ? "Procurando…" : "🔄 Procurar atualização"}</button>`}
      </section>
      <section class="cartao dados">
        <b>Espaço no celular</b>
        <div id="espaco">${estado.espacoHtml || `<p class="sub">Medindo…</p>`}</div>
      </section>
      ${p.admin ? `<section class="cartao dados">
        <b>Supervisores</b>
        <p class="sub">Para criar a conta de um supervisor ou trocar a senha, use o <b>Painel › 👥 Usuários</b>. Aqui dá para ajustar o nome que sai na medição e o acesso.</p>
        ${sups === null ? `<p class="vazio">Carregando…</p>` : sups.map((s) => `<div class="sup-linha">
          <input value="${esc(s.nome)}" data-sup-nome="${s.user_id}" aria-label="Nome de ${esc(s.email)}">
          <small class="sub">${esc(s.email)}</small>
          <label><input type="checkbox" data-sup-ativo="${s.user_id}" ${s.ativo ? "checked" : ""}> ativo</label>
          <label><input type="checkbox" data-sup-admin="${s.user_id}" ${s.admin ? "checked" : ""} ${s.user_id === p.user_id ? "disabled" : ""}> administrador</label>
        </div>`).join("")}
      </section>` : ""}
    </div>`;
  }

  // ---------- obra (dados)
  function telaObraForm() {
    const o = estado.obra;
    const nova = !o.criada_em;
    return `<div class="pagina pagina-form">
      ${topo(nova ? "Nova obra" : "Dados da obra", nova ? "inicio" : "obra")}
      <section class="cartao dados">
        <label class="campo">Número da obra
          <input id="f-numero" value="${esc(o.numero)}" autocomplete="off" inputMode="numeric" maxlength="10" placeholder="8 ou 10 dígitos" class="${!o.numero ? "" : obraValida(o.numero) ? "valido" : "invalido"}">
          <small class="dica-erro" id="dica-numero">${o.numero && !obraValida(o.numero) ? `Tem ${o.numero.length} dígitos. Precisa de 8 ou 10.` : ""}</small>
        </label>
        <label class="campo"><span>Cidade <small>(se tiver)</small></span>
          <input id="f-municipio" value="${esc(o.municipio)}">
        </label>
        <label class="campo"><span>Observação <small>(se tiver)</small></span>
          <textarea id="f-obs" rows="2">${esc(o.obs)}</textarea>
        </label>
      </section>
      <section class="cartao dados" id="sec-projeto">${projetoHtml(o)}</section>
      <div class="erro" id="erro-form" hidden></div>
      <div class="rodape"><button type="button" class="botao" data-acao="salvar-obra">${nova ? "Criar obra" : "Salvar"}</button></div>
    </div>`;
  }

  const fmtMb = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  /** projeto da obra (o croqui): o que está anexado e o botão de anexar/trocar */
  function projetoHtml(o) {
    const novo = estado.projetoNovo;
    const atual = novo ? { nome: novo.nome, tamanho: novo.blob.size, paginas: novo.paginas } : o.projeto;
    const marcados = o.pontos.filter((p) => p.croqui).length;
    const folhas = atual?.paginas > 1 ? ` · ${atual.paginas} folhas` : "";
    return `<b>Projeto da obra <small class="sub-inline">(croqui)</small></b>
      <p class="sub">PDF ou foto do projeto. É nele que você toca no poste para lançar os serviços. A obra tem mais de um croqui? Escolha todos de uma vez ou use "Adicionar folhas": eles viram as folhas do projeto.</p>
      ${estado.juntando ? `<p class="sub">⏳ Juntando os croquis…</p>` : ""}
      ${atual ? `<div class="projeto-atual"><span>📄</span><div><b>${esc(atual.nome)}</b><small class="sub">${fmtMb(atual.tamanho || 0)}${folhas}${novo ? " · novo, falta salvar" : ""}</small></div></div>` : ""}
      ${novo?.modo === "trocar" && o.projeto && marcados ? `<p class="faixa faixa-guardado">Os ${marcados} pontos já marcados ficam no mesmo lugar da folha. Se o projeto novo for diferente, mude o lugar deles no croqui.</p>` : ""}
      <div class="dupla">
        <label class="botao ${atual ? "botao-claro" : ""}">📎 ${atual ? "Trocar o projeto" : "Anexar o projeto"}<input type="file" accept="application/pdf,.pdf,image/*" multiple data-acao="projeto" data-modo="trocar" hidden></label>
        ${atual ? `<label class="botao botao-claro">➕ Adicionar folhas<input type="file" accept="application/pdf,.pdf,image/*" multiple data-acao="projeto" data-modo="adicionar" hidden></label>` : ""}
      </div>`;
  }

  // ---------- obra (pontos)
  function telaObra() {
    const o = estado.obra;
    const t = M.totaisObra(o);
    // pesquisa do ponto: nome, observação ou serviço lançado (código, descrição ou nome curto)
    const termos = normalizar(estado.filtroPonto || "").split(/\s+/).filter(Boolean);
    // os serviços da obra (sem ponto) têm cartão próprio, fora da lista de pontos
    const reais = M.pontosReais(o.pontos);
    const geral = o.pontos.find((p) => p.geral);
    const tg = geral ? M.totaisPonto(geral) : null;
    const cartaoGeral = soLeitura(o) && !geral?.itens.length ? "" : `<button type="button" class="cartao ponto-item ponto-geral" data-acao="abrir-geral">
        <div class="linha-topo"><b class="ponto-nome">🧰 Serviços da obra <small>(sem ponto)</small></b>${tg?.valor ? `<b class="valor">${M.fmtMoeda(tg.valor)}</b>` : ""}</div>
        <small class="sub">${geral?.itens.length ? `${plural(geral.itens.length, "serviço", "serviços")} · somam no total da obra` : "Serviço que não é de um ponto: lance aqui e ele soma no total da obra"}</small>
      </button>`;
    const achados = termos.length
      ? reais.filter((p) => {
        const texto = normalizar([p.nome, p.obs, ...p.itens.flatMap((i) => [i.codigo, i.descricao, nomeNaTela(i)])].join(" "));
        return termos.every((x) => texto.includes(x));
      })
      : reais;
    const ordenados = [...achados].sort((a, b) => (estado.ordemPontos === "decr" ? -cmpPonto(a, b) : cmpPonto(a, b)));
    const pontos = ordenados.map((p) => {
      const tp = M.totaisPonto(p);
      return `<button type="button" class="cartao ponto-item" data-acao="abrir-ponto" data-id="${p.id}">
        <div class="linha-topo"><b class="ponto-nome">${esc(p.nome)}</b><b class="valor">${M.fmtMoeda(tp.valor)}</b></div>
        <small class="sub">${plural(p.itens.length, "serviço", "serviços")} · ${p.fotos.length ? "📷 " + p.fotos.length : "sem foto"}${p.gps ? " · 📍" : ""}${o.projeto ? (p.croqui ? " · 📌 no croqui" : " · fora do croqui") : ""}</small>
        ${p.obs ? `<small class="sub">${esc(p.obs)}</small>` : ""}
      </button>`;
    }).join("");
    return `<div class="pagina pagina-form pagina-larga">
      ${topo("Obra", "inicio", soLeitura(o) ? "" : `<button type="button" class="link" data-acao="editar-obra">Editar</button>`)}
      <div id="faixa-analise">${faixaAnalise()}</div>
      <div class="linha-topo"><span id="selo-obra">${seloHtml(o)}</span>${o.enviada_em ? `<small class="sub">no banco desde ${M.fmtHora(o.enviada_em)}</small>` : ""}</div>
      ${soLeitura(o) ? `<div class="faixa faixa-consulta">Obra de ${esc(o.supervisor_nome || "outro supervisor")}: aberta só para consulta e para gerar a medição.</div>` : ""}
      ${o.erro_envio ? `<div class="erro">O banco recusou o envio: ${esc(o.erro_envio)}</div>` : ""}
      <div class="chips">
        <span class="chip-obra"><small>OBRA</small><b>${esc(o.numero)}</b></span>
        <span class="chip chip-total">Total <b>${M.fmtMoeda(t.valor)}</b></span>
        <span class="chip chip-us"><b>${M.fmtNum(t.us)}</b> US</span>
        <span class="chip"><b>${reais.length}</b> ${reais.length === 1 ? "ponto" : "pontos"}</span>
      </div>
      ${o.local || o.municipio || o.equipe ? `<p class="sub">${esc([o.local, o.municipio, o.equipe].filter(Boolean).join(" · "))}</p>` : ""}
      ${o.projeto ? `<button type="button" class="botao botao-grande" data-acao="croqui">🗺 Abrir o croqui <small>${soLeitura(o) ? "toque num ponto para ver o que foi feito" : "toque no poste para lançar os serviços"}</small></button>`
        : soLeitura(o) ? "" : `<div class="cartao dados sem-projeto"><b>Medir pelo croqui</b><p class="sub">Anexe o projeto da obra (PDF ou foto) para tocar no poste e lançar ali os serviços.</p>
          <button type="button" class="botao" data-acao="editar-obra">📎 Anexar o projeto</button></div>`}
      ${o.projeto && !soLeitura(o) ? `<button type="button" class="botao botao-claro botao-pequeno" data-acao="analisar-projeto" ${estado.analise?.obraId === o.id && /pontos|servicos/.test(estado.analise.fase) ? "disabled" : ""}>🔎 Achar todos os pontos (P) do projeto</button>` : ""}
      ${soLeitura(o) ? "" : `<button type="button" class="botao ${o.projeto ? "botao-claro botao-pequeno" : "botao-grande"}" data-acao="novo-ponto">+ Novo ponto${o.projeto ? " fora do croqui" : ""} <small>${esc(proximoNome(o))}</small></button>`}
      ${cartaoGeral}
      <section class="bloco">
        <div class="titulo-pontos">
          <h2>Pontos da obra ${termos.length ? `<small class="sub-inline">(${achados.length} de ${reais.length})</small>` : ""}</h2>
          ${reais.length > 1 ? `<div class="ordem" role="group" aria-label="Ordem dos pontos">
            <button type="button" data-acao="ordem-pontos" data-ordem="cresc" class="${estado.ordemPontos === "cresc" ? "ativo" : ""}" aria-pressed="${estado.ordemPontos === "cresc"}">↑ P1…P9</button>
            <button type="button" data-acao="ordem-pontos" data-ordem="decr" class="${estado.ordemPontos === "decr" ? "ativo" : ""}" aria-pressed="${estado.ordemPontos === "decr"}">↓ P9…P1</button>
          </div>` : ""}
        </div>
        ${reais.length ? `<label class="campo campo-pesquisa"><input id="filtro-ponto" type="search" value="${esc(estado.filtroPonto || "")}" placeholder="Pesquisar ponto: P3, observação ou serviço (ex.: poste, 62297)" autocomplete="off"></label>` : ""}
        ${pontos ? `<div class="grade-pontos">${pontos}</div>`
          : reais.length ? `<p class="vazio">Nenhum ponto encontrado.</p>`
            : `<p class="vazio">Nenhum ponto ainda. Cada poste ou trecho é um ponto (P1, P2...).</p>`}
      </section>
      <section class="bloco acoes-obra">
        <button type="button" class="botao botao-perigo" data-acao="excluir-obra">${soLeitura(o) ? "Tirar deste celular" : "Excluir obra"}</button>
      </section>
      <div class="rodape">
        <div class="rodape-total"><span>Total da obra</span><b>${M.fmtMoeda(t.valor)}</b></div>
        <button type="button" class="botao" data-acao="medicao" ${o.pontos.some((p) => p.itens.length) ? "" : "disabled"}>Gerar medição</button>
      </div>
    </div>`;
  }

  // ---------- croqui
  /* O projeto aberto em tela cheia. Toque num lugar vazio: pergunta se cria ali o
     próximo ponto. Toque num ponto: mostra embaixo o que foi feito nele (serviços,
     quantidades, fotos) sem sair do croqui. O visor (croqui.js) é um só e fica vivo
     entre as telas: voltar do ponto mantém o zoom e o lugar onde o supervisor estava. */
  let visor = null;
  function pegarVisor() {
    if (visor) return visor;
    visor = new Croqui.Visor();
    visor.onVazio = tocouVazio;
    visor.onMarca = tocouMarca;
    return visor;
  }
  const arred = (v) => Math.round(v * 100000) / 100000;
  const pontoPorId = (id) => estado.obra?.pontos.find((p) => p.id === id) || null;
  /** os postes da obra: os pontos de verdade, sem os vãos (que também são lançados na medição) */
  const postes = (o) => M.pontosReais(o.pontos).filter((p) => !p.vao);
  /** anotações e rascunho do campo no croqui: { notas: [{ id, pag, x, y, texto }], tracos: [{ id, pag, pts }] } */
  const anotacoes = (o) => {
    if (!o.anotacoes) o.anotacoes = { notas: [], tracos: [] };
    o.anotacoes.notas = o.anotacoes.notas || [];
    o.anotacoes.tracos = o.anotacoes.tracos || [];
    return o.anotacoes;
  };
  const nomeDoPoste = (id) => pontoPorId(id)?.nome || "?";
  /** giro da folha no croqui (0, 90, 180, 270), guardado no projeto da obra por folha */
  const giroDa = (o, pag) => Number(o?.projeto?.giros?.[pag]) || 0;
  /** "35 m · 4 esp." do vão (o que já foi informado) */
  const medidasVao = (v) => (v.vao.metros ? `${v.vao.metros} m` : "");
  /** Vão entre dois postes desta folha em que o toque caiu: o toque fica "entre" os dois (na
   *  direção da reta, nem antes de um nem depois do outro) e, dos que servem, o mais perto da
   *  reta. A marca do ponto fica no (P) verde, às vezes longe do poste: o toque na rede pode
   *  cair bem ao lado da reta entre as marcas (até 3 vezes o comprimento do vão). */
  function vaoTocado(pos) {
    if (!visor?.W) return null;
    const ps = postes(estado.obra).filter((p) => p.croqui && (p.croqui.pag || 1) === pos.pag);
    const kx = visor.W * visor.s, ky = visor.H * visor.s; // fração da folha -> px da tela
    const perto = (q, a, b, folga) => {
      const dx = (b.x - a.x) * kx, dy = (b.y - a.y) * ky, L2 = dx * dx + dy * dy;
      if (L2 < 1) return null;
      const t = ((q.x - a.x) * kx * dx + (q.y - a.y) * ky * dy) / L2;
      if (t < folga || t > 1 - folga) return null;
      return { d: Math.hypot(a.x * kx + t * dx - q.x * kx, a.y * ky + t * dy - q.y * ky), L: Math.sqrt(L2) };
    };
    // vão é entre vizinhos: um dos dois está entre os 3 postes mais perto do outro
    const dist = (a, b) => Math.hypot((a.x - b.x) * kx, (a.y - b.y) * ky);
    const vizinhos = ps.map((p) => new Set(ps.filter((q) => q !== p).sort((q, r) => dist(p.croqui, q.croqui) - dist(p.croqui, r.croqui)).slice(0, 3)));
    let melhor = null;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        if (!vizinhos[i].has(ps[j]) && !vizinhos[j].has(ps[i])) continue;
        const a = ps[i].croqui, b = ps[j].croqui;
        const m = perto(pos, a, b, 0.05);
        if (!m || m.d > Math.max(40, m.L * 3)) continue;
        // outro poste em cima do trecho: não é um vão só (é P1-P2 e P2-P3)
        if (ps.some((c, k) => k !== i && k !== j && (perto(c.croqui, a, b, 0.02)?.d ?? 99) < Math.max(14, m.L * 0.12))) continue;
        if (!melhor || m.d < melhor.d || (m.d === melhor.d && m.L < melhor.L)) melhor = { de: ps[i].id, para: ps[j].id, L: m.L, d: m.d };
      }
    }
    return melhor && { de: melhor.de, para: melhor.para };
  }
  /** linha do vão de poste a poste (quadradinho a quadradinho), quando o app tem certeza */
  async function acharLinhaDoVao(v) {
    const o = estado.obra;
    const a = pontoPorId(v.vao.de)?.croqui, b = pontoPorId(v.vao.para)?.croqui;
    if (!o || !a || !b) return;
    try {
      const proj = await garantirProjeto(o);
      const l = proj && (await Croqui.linhaDoVao(proj, a, b));
      if (!o.pontos.includes(v) || v.vao.linha) return; // excluído ou já ajustado à mão
      if (l) {
        v.vao.linha = l;
        salvarAgora();
        if (estado.tela === "croqui") atualizarMarcas();
      } else {
        avisar(`Não achei sozinho os postes do ${v.nome}. No croqui, toque no vão e em ↔ Ajustar linha.`, "guardado");
      }
    } catch (e) {
      console.warn("linha do vão:", e);
    }
  }
  /** toque no modo "Ajustar linha": gruda no quadradinho do poste mais perto do toque */
  async function ajustarVao(aj, pos) {
    if (aj.ocupado) return;
    aj.ocupado = true;
    let q = pos;
    try {
      const proj = await garantirProjeto(estado.obra);
      q = (proj && (await Croqui.acharPosteSimbolo(proj, pos, 0.035))) || pos;
    } catch (e) {
      console.warn("poste perto do toque:", e);
    }
    aj.ocupado = false;
    if (estado.cqAjuste !== aj) return;
    aj.pts.push([arred(q.x), arred(q.y)]);
    aj.pag = pos.pag;
    const v = pontoPorId(aj.id);
    if (aj.pts.length < 2 || !v) return render();
    v.vao.linha = aj.pts;
    // poste extra (ou fora do croqui): fica onde o supervisor tocou
    [v.vao.de, v.vao.para].forEach((id, i) => {
      const q = pontoPorId(id);
      if (q && !q.croqui) q.croqui = { pag: pos.pag, x: aj.pts[i][0], y: aj.pts[i][1] };
    });
    v.croqui = { pag: pos.pag, x: arred((aj.pts[0][0] + aj.pts[1][0]) / 2), y: arred((aj.pts[0][1] + aj.pts[1][1]) / 2) };
    estado.cqAjuste = null;
    estado.cqSel = v.id;
    salvarAgora();
    avisar("Linha do vão ajustada.");
    render();
  }
  /** mudou o começo ou o fim do vão: novo nome, e a linha é refeita (de poste a poste) */
  function trocarPostesDoVao(v, campo) {
    const o = estado.obra;
    const nome = campo.value.trim().toUpperCase().slice(0, 30);
    if (!nome) return render(); // apagou: volta o que era
    let q = postes(o).find((x) => x.nome.trim().toUpperCase() === nome);
    if (!q) {
      // poste extra, que não está no projeto: entra na obra e ganha lugar ao remarcar a linha
      q = { id: novoId(), nome, dia: "", obs: "", gps: null, croqui: null, itens: [], fotos: [], extra: true };
      o.pontos.push(q);
      avisar(`Poste extra ${nome} criado. Toque em 📌 Remarcar a linha no croqui para marcar onde ele fica.`, "guardado");
    }
    const de = campo.id === "p-vao-de" ? q.id : v.vao.de, para = campo.id === "p-vao-para" ? q.id : v.vao.para;
    if (de === para) { avisar("O vão precisa de dois postes diferentes.", "erro"); return render(); }
    const outro = vaoEntre(o, de, para);
    if (outro && outro !== v) { avisar(`Já existe o ${outro.nome}.`, "erro"); return render(); }
    Object.assign(v.vao, { de, para, linha: null });
    v.nome = `Vão ${nomeDoPoste(de)}–${nomeDoPoste(para)}`;
    const a = pontoPorId(de)?.croqui, b = pontoPorId(para)?.croqui;
    if (a && b) v.croqui = { pag: a.pag || 1, x: arred((a.x + b.x) / 2), y: arred((a.y + b.y) / 2) };
    salvarAgora();
    render();
    if (a && b) acharLinhaDoVao(v);
  }
  const vaoEntre = (o, de, para) => o.pontos.find((p) => p.vao && ((p.vao.de === de && p.vao.para === para) || (p.vao.de === para && p.vao.para === de)));
  function terminarTraco(pts) {
    const o = estado.obra;
    if (!o || soLeitura(o)) return;
    anotacoes(o).tracos.push({ id: novoId(), pag: estado.cqPag, pts });
    salvarAgora();
    atualizarMarcas();
  }

  // ---------- análise geral do projeto
  // Ao anexar o projeto: acha todos os "(P)" verdes, cria os pontos já marcados no croqui e
  // lê as sugestões de cada um. Na hora de medir é só abrir o ponto e lançar.
  /** Análise em andamento, guardada no aparelho: { [obraId]: { pag, grupo, parciais, pags } }.
   *  Se a tela recarrega ou o celular fecha o app, ela continua de onde parou ao abrir de novo. */
  const lerAnalises = () => Banco.ler("analises", {});
  async function guardarAnalise(id, dados) {
    const todas = await lerAnalises();
    if (dados) todas[id] = dados; else delete todas[id];
    await Banco.gravar("analises", todas);
  }

  // ---------- os (P) lidos do projeto (o supervisor decide os pontos: 18/11/2026)
  // A análise só lê os rótulos (P) de cada folha e guarda nome e lugar no aparelho:
  // { [obraId]: { em, pags: { [pag]: [{ nome, x, y }] } } }. Tocar no poste pega o nome daqui na
  // hora, sem esperar o OCR; o ponto só nasce quando o supervisor toca.
  let rotulosCache = null;
  async function todosRotulos() {
    if (!rotulosCache) rotulosCache = await Banco.ler("rotulos", {});
    return rotulosCache;
  }
  async function guardarRotulos(o, pag, lista) {
    const todos = await todosRotulos();
    const em = o.projeto?.em || "";
    if (!todos[o.id] || todos[o.id].em !== em) todos[o.id] = { em, pags: {} };
    todos[o.id].pags[pag] = lista.map((x) => ({ nome: x.nome, x: arred(x.x), y: arred(x.y) }));
    await Banco.gravar("rotulos", todos);
  }
  /** o (P) já lido bem embaixo do toque, ou null (aí o OCR lê na hora) */
  async function rotuloPerto(o, pos) {
    const em = o.projeto?.em || "";
    const local = (await todosRotulos())[o.id];
    // a leitura deste aparelho vale primeiro (tem a folha que está sendo lida agora); senão,
    // a que veio com a obra do banco (lida em outro celular ou no computador)
    const daqui = local && local.em === em ? local.pags[pos.pag] : null;
    const daObra = o.rotulos && o.rotulos.em === em ? o.rotulos.pags?.[pos.pag] : null;
    const lista = daqui || daObra || [];
    if (!lista.length) return null;
    const k = visor?.W ? (visor.giro % 180 ? visor.W / visor.H : visor.H / visor.W) : 1.3; // altura/largura da folha
    // largura da folha na tela, em px (com o zoom de agora)
    const larguraTela = visor?.W ? (visor.giro % 180 ? visor.H : visor.W) * visor.s : 0;
    let melhor = null;
    for (const x of lista) {
      const d = Math.hypot(x.x - pos.x, (x.y - pos.y) * k);
      if (!melhor || d < melhor.d) melhor = { ...x, d };
    }
    // vale só o (P) bem embaixo do dedo: com vários (P) juntos, o rótulo que a leitura não pegou
    // (P16, P17...) não pode virar o vizinho lido (P14). Mais longe: o OCR lê ali na hora
    if (!melhor) return null;
    const px = larguraTela ? melhor.d * larguraTela : 0;
    return melhor.d <= 0.012 && (!larguraTela || px <= 16) ? melhor : null;
  }
  /** quantos (P) já foram lidos na obra */
  async function contarRotulos(o) {
    const local = (await todosRotulos())[o.id];
    const r = local && local.em === (o.projeto?.em || "") ? local : o.rotulos;
    return r ? Object.values(r.pags || {}).reduce((n, l) => n + l.length, 0) : 0;
  }
  const temRotulos = (o) => !!o?.rotulos && o.rotulos.em === (o.projeto?.em || "");
  /** Ao abrir o app: a leitura dos (P) feita neste aparelho entra nas obras e sobe para o banco,
   *  de todas de uma vez (antes só subia ao abrir o croqui de cada obra). */
  async function subirLeiturasLocais() {
    const todos = await todosRotulos();
    let n = 0;
    for (const o of await Banco.listarObras()) {
      if (soLeitura(o) || !o.projeto) continue;
      const local = todos[o.id];
      if (!local || local.em !== (o.projeto.em || "")) continue;
      if (temRotulos(o) && JSON.stringify(o.rotulos.pags) === JSON.stringify(local.pags)) continue;
      o.rotulos = { em: local.em, pags: JSON.parse(JSON.stringify(local.pags)) };
      await Banco.salvarObra(o);
      n++;
    }
    if (n) {
      await recarregarLocais();
      enviarDepois(500);
    }
  }
  /** Obra aberta sem a leitura dos (P): busca a que outro aparelho mandou para o banco. Só a
   *  leitura entra (o que este celular tem para enviar não muda). */
  async function rotulosDoBanco(o) {
    if (!navigator.onLine || !Nuvem.lerSessao()) return false;
    try {
      const r = await Nuvem.baixarObra(o.id);
      const rot = r?.projeto?.rotulos;
      if (!rot || rot.em !== (o.projeto?.em || "")) return false;
      o.rotulos = rot;
      await Banco.salvarObra(o, { envio: true });
      return true;
    } catch (e) {
      console.warn("leitura dos (P) do banco:", e);
      return false;
    }
  }
  /** a leitura da folha vai para a obra e sobe com ela para o banco (serve em qualquer aparelho) */
  async function rotulosNaObra(o) {
    const local = (await todosRotulos())[o.id];
    if (!local || local.em !== (o.projeto?.em || "")) return false;
    o.rotulos = { em: local.em, pags: JSON.parse(JSON.stringify(local.pags)) };
    return true;
  }
  /** Pontos vazios que a análise antiga (até a versão 45) criava sozinha: saem da obra. O que
   *  tem serviço, foto ou observação fica. */
  function tirarPontosAutomaticos(o) {
    const antes = o.pontos.length;
    // poste que é começo ou fim de um vão fica (o vão precisa dele)
    const doVao = new Set(o.pontos.filter((p) => p.vao).flatMap((v) => [v.vao.de, v.vao.para]));
    o.pontos = o.pontos.filter((p) => !(p.doProjeto && !doVao.has(p.id) && !p.itens.length && !p.fotos.length && !(p.obs || "").trim()));
    o.pontos.forEach((p) => { delete p.provisorio; delete p.perto; });
    return antes - o.pontos.length;
  }
  // tela ligada enquanto a busca roda: com a tela bloqueada o celular congela a página e a
  // busca para (o celular libera sozinho se o app sair da frente; volta quando ele volta)
  let travaTela = null;
  async function manterTelaLigada(ligar) {
    try {
      if (ligar) {
        if (!travaTela && navigator.wakeLock && document.visibilityState === "visible") {
          travaTela = await navigator.wakeLock.request("screen");
          travaTela.addEventListener("release", () => { travaTela = null; });
        }
      } else if (travaTela) {
        const t = travaTela;
        travaTela = null;
        await t.release();
      }
    } catch (e) {
      travaTela = null; // sem suporte ou bateria fraca: segue sem
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && estado.analise?.fase === "pontos") manterTelaLigada(true);
  });

  /** retoma a leitura que parou (tela recarregada, app fechado): a primeira da fila */
  // obra que deu erro nesta abertura do app (ex.: projeto não baixado): não trava a fila; tenta
  // de novo na próxima vez que o app abrir
  const falharamAgora = new Set();
  async function retomarAnalise() {
    if (estado.analise?.fase === "pontos") return atualizarFila();
    const todas = await lerAnalises();
    // pela ordem do pedido (a que parou no meio continua primeiro)
    const ordem = Object.entries(todas).sort((x, y) => (x[1].fila || 0) - (y[1].fila || 0));
    for (const [id, dados] of ordem) {
      if (falharamAgora.has(id)) continue;
      const obra = await Banco.obterObra(id);
      if (!obra?.projeto || soLeitura(obra) || (await obrasExcluidas()).has(id)) { await guardarAnalise(id, null); continue; }
      return analisarProjeto(obra, dados);
    }
    return atualizarFila();
  }
  /** obras esperando a vez de ler os (P), para mostrar na lista */
  async function atualizarFila() {
    const todas = await lerAnalises();
    const ids = Object.entries(todas).sort((x, y) => (x[1].fila || 0) - (y[1].fila || 0)).map(([id]) => id)
      .filter((id) => id !== estado.analise?.obraId || estado.analise?.fase !== "pontos");
    const fila = [];
    for (const id of ids) {
      const o = await Banco.obterObra(id);
      if (o) fila.push({ id, numero: o.numero });
    }
    estado.filaAnalise = fila;
    mostrarAnalise();
  }
  /** Pede a leitura dos (P) da obra, do começo. Com outra obra sendo lida, entra na fila e
   *  começa sozinha quando a vez chegar (a fila fica guardada: sobrevive à tela recarregar). */
  async function pedirAnalise(o) {
    if (!o?.projeto || soLeitura(o)) return;
    if (estado.analise?.fase === "pontos" && estado.analise.obraId === o.id) return avisar(`Os (P) da obra ${o.numero} já estão sendo lidos.`, "guardado");
    falharamAgora.delete(o.id);
    await guardarAnalise(o.id, { pag: 1, grupo: 0, parciais: [], pags: o.projeto.paginas || null, fila: Date.now() });
    if (estado.analise?.fase === "pontos") {
      avisar(`Obra ${o.numero} na fila: os (P) dela são lidos quando a obra ${estado.analise.numero} terminar.`, "guardado", 6000);
      return atualizarFila();
    }
    return retomarAnalise();
  }

  async function analisarProjeto(obra, retomar = null) {
    if (!obra?.projeto || soLeitura(obra) || estado.analise?.fase === "pontos") return;
    const a = (estado.analise = { obraId: obra.id, numero: obra.numero, fase: "pontos", feitos: 0, total: 0, achados: 0, pag: retomar?.pag || 1, pags: retomar?.pags || 1 });
    mostrarAnalise();
    manterTelaLigada(true);
    atualizarFila();
    // a obra pode ter sido recarregada no meio: trabalha na que está valendo
    const valendo = async () => (estado.obra?.id === obra.id ? estado.obra : (await Banco.obterObra(obra.id)) || obra);
    try {
      const proj = await garantirProjeto(obra);
      if (!proj) throw new Error("O projeto não está neste celular.");
      // os pontos vazios que a análise antiga criou sozinha saem (agora o supervisor decide)
      {
        const o = await valendo();
        if (tirarPontosAutomaticos(o)) {
          if (estado.obra === o) { await salvarAgora(); if (estado.tela === "croqui") render(); }
          else { await Banco.salvarObra({ ...o, dono: true }); enviarDepois(); }
        }
      }
      const pags = await Croqui.paginas(proj);
      a.pags = pags;
      const excluida = async () => (await obrasExcluidas()).has(obra.id);
      for (let pag = retomar?.pag || 1; pag <= pags; pag++) {
        if (await excluida()) throw new Error("A obra foi excluída.");
        const doMeio = retomar && retomar.pag === pag ? retomar : null; // folha que parou no meio
        await guardarAnalise(obra.id, { pag, grupo: doMeio?.grupo || 0, parciais: doMeio?.parciais || [], pags, fila: retomar?.fila || 1 });
        const daFolha = await Croqui.acharPontos(proj, pag, (f, t) => { Object.assign(a, { feitos: f, total: t, pag, pags }); mostrarAnalise(); }, {
          inicio: doMeio?.grupo || 0,
          parciais: doMeio?.parciais || [],
          aoGuardar: async (grupo, parciais) => {
            await guardarAnalise(obra.id, { pag, grupo, parciais, pags, fila: retomar?.fila || 1 });
            // cada (P) lido já vale para o toque, sem esperar a folha acabar
            await guardarRotulos(obra, pag, parciais);
          },
        });
        if (await excluida()) throw new Error("A obra foi excluída.");
        // fim da folha: a lista conferida (P17 -> P117, símbolo verde fora) substitui a parcial
        await guardarRotulos(obra, pag, daFolha);
        // e vai junto com a obra para o banco: o computador e os outros celulares já recebem lida
        {
          const o = await valendo();
          if (await rotulosNaObra(o)) {
            if (estado.obra === o) await salvarAgora();
            else { await Banco.salvarObra({ ...o, dono: true }); enviarDepois(); }
          }
        }
        a.achados += daFolha.length;
        await guardarAnalise(obra.id, pag < pags ? { pag: pag + 1, grupo: 0, parciais: [], pags, fila: retomar?.fila || 1 } : null);
      }
      a.fase = "pronto";
      a.lidos = await contarRotulos(obra);
      avisar(`✓ Obra ${obra.numero}: ${plural(a.lidos, "(P) lido", "(P) lidos")}${pags > 1 ? ` em ${pags} folhas` : ""}. Toque no poste para marcar.`, "ok", 9000);
      try { navigator.vibrate?.([150, 80, 150]); } catch (e) { /* sem vibrar */ }
    } catch (e) {
      console.warn("leitura do projeto:", e);
      Object.assign(a, { fase: "erro", erro: e.message });
      if (/excluída/.test(e.message || "")) await guardarAnalise(obra.id, null);
      else {
        falharamAgora.add(obra.id);
        avisar(`Não deu para ler os (P) da obra ${obra.numero}: ${e.message}`, "erro", 9000);
      }
    }
    mostrarAnalise();
    manterTelaLigada(false); // a próxima obra da fila (se tiver) liga de novo
    // a próxima obra da fila (ou a que ficou pela metade) começa sozinha
    setTimeout(retomarAnalise, 1000);
  }
  /** andamento da análise de 0 a 100 (as folhas uma depois da outra) */
  const andamentoAnalise = (a) => Math.min(99, Math.round((((a.pag || 1) - 1) + (a.total ? a.feitos / a.total : 0)) / (a.pags || 1) * 100));
  /** a análise nas outras telas (lista de obras e obra): andamento e o aviso de pronto */
  function faixaAnalise() {
    const a = estado.analise;
    const fila = (estado.filaAnalise || []).filter((x) => x.id !== a?.obraId || a?.fase !== "pontos");
    const naFila = fila.length ? `<div class="faixa faixa-fila">⏳ Na fila para ler os (P): ${fila.map((x) => `<b>${esc(x.numero)}</b>`).join(", ")}</div>` : "";
    return faixaDaAnalise(a) + naFila;
  }
  function faixaDaAnalise(a) {
    if (!a) return "";
    if (a.fase === "pontos" || a.fase === "servicos") {
      return `<div class="faixa faixa-analise"><span>🔎 Lendo os (P) da obra <b>${esc(a.numero)}</b>${a.pags > 1 ? ` · folha ${a.pag} de ${a.pags}` : ""} · ${andamentoAnalise(a)}%${travaTela ? " · 🔆 tela ligada até terminar" : ""}</span></div>`;
    }
    if (a.fase === "pronto") {
      return `<div class="faixa faixa-ok faixa-analise"><span>✓ Obra <b>${esc(a.numero)}</b>: ${plural(a.lidos ?? a.achados, "(P) lido", "(P) lidos")}${a.pags > 1 ? ` em ${a.pags} folhas` : ""}. Toque no poste e o nome vem na hora.</span>
        <span class="faixa-botoes"><button type="button" class="link" data-acao="abrir-obra" data-id="${esc(a.obraId)}">Ver no croqui</button><button type="button" class="remover" data-acao="analise-ok" aria-label="Fechar">×</button></span></div>`;
    }
    return `<div class="faixa faixa-erro faixa-analise"><span>Não deu para ler os (P) da obra ${esc(a.numero)}${a.erro ? `: ${esc(a.erro)}` : ""}.</span><button type="button" class="remover" data-acao="analise-ok" aria-label="Fechar">×</button></div>`;
  }

  function analiseHtml(o) {
    const a = estado.analise;
    if (!a || a.obraId !== o.id) return "";
    if (a.fase === "pronto" || a.fase === "erro") {
      const t = a.fase === "pronto"
        ? `✓ <b>${plural(a.lidos ?? a.achados, "(P) lido", "(P) lidos")}</b>${a.pags > 1 ? ` nas ${a.pags} folhas` : ""}. Toque no poste: o nome vem na hora.`
        : `Não deu para ler os (P)${a.erro ? `: ${esc(a.erro)}` : ""}.`;
      return `<div class="cq-dica cq-analise cq-analise-fim${a.fase === "erro" ? " cq-analise-erro" : ""}" id="cq-analise"><span>${t}</span><button type="button" class="link" data-acao="analise-ok">OK</button></div>`;
    }
    const t = a.fase === "pontos" ? `🔎 Lendo os (P) do projeto${a.pags > 1 ? ` · folha ${a.pag} de ${a.pags}` : ""}… ${andamentoAnalise(a)}%`
      : `🔎 Lendo os serviços de cada ponto… ${a.feitos} de ${a.total}`;
    return `<div class="cq-dica cq-analise" id="cq-analise"><span>${t}</span></div>`;
  }
  /** troca só o aviso da análise (refazer a tela tiraria o zoom de lugar) */
  function mostrarAnalise() {
    const faixa = document.getElementById("faixa-analise"); // lista de obras e obra
    if (faixa) faixa.innerHTML = faixaAnalise();
    const el = document.getElementById("cq-analise");
    const o = estado.obra;
    if (estado.tela !== "croqui" || !o) return;
    const html = analiseHtml(o);
    if (el) el.outerHTML = html || "";
    else if (html && !estado.cqNovo && !estado.cqSel && !estado.cqMover) document.getElementById("cq-area")?.insertAdjacentHTML("afterbegin", html);
  }

  /** A troca de folha fica logo acima do que cobre o pé do croqui (a barra do total ou o
   *  resumo do ponto); no computador o resumo vai para a direita e a barra continua embaixo. */
  function acimaDaBarra() {
    const pg = document.querySelector(".pagina-croqui"), area = pg?.querySelector(".cq-area");
    if (!area) return;
    const a = area.getBoundingClientRect(), meio = a.left + a.width / 2;
    let h = 0;
    for (const el of pg.querySelectorAll(":scope > .cq-barra, :scope > .cq-folha")) {
      const r = el.getBoundingClientRect();
      if (r.left < meio && r.right > meio && r.bottom >= a.bottom - 2) h = Math.max(h, a.bottom - r.top);
    }
    area.style.setProperty("--baixo", `${Math.round(h)}px`);
  }
  window.addEventListener("resize", () => { if (estado.tela === "croqui") acimaDaBarra(); });
  TELA_LARGA.addEventListener?.("change", () => { if (estado.tela === "croqui" && estado.cqPainel) render(); });

  function telaCroqui() {
    const o = estado.obra;
    // virou celular em pé (ou a janela encolheu) com o painel aberto: o ponto vai para a tela dele
    if (estado.cqPainel && !painelLateral()) {
      estado.tela = "ponto";
      estado.cqPainel = null;
      return telaPonto();
    }
    const painel = estado.cqPainel && ponto() ? `<aside class="cq-painel" id="cq-painel" aria-label="Lançamento do ponto">${telaPonto()}</aside>` : "";
    const t = M.totaisObra(o);
    const reais = postes(o);
    const marcados = reais.filter((p) => p.croqui).length;
    const sel = pontoPorId(estado.cqSel);
    const mover = pontoPorId(estado.cqMover);
    const pags = o.projeto?.paginas || visor?.paginas || 1;
    const pag = Math.min(estado.cqPag, pags);
    const aj = estado.cqAjuste, vAj = aj && pontoPorId(aj.id);
    const dica = vAj ? `<div class="cq-dica cq-dica-mover"><span>📏 Toque no poste ${aj.pts.length ? `de fim (<b>${esc(nomeDoPoste(vAj.vao.para))}</b>)` : `de início (<b>${esc(nomeDoPoste(vAj.vao.de))}</b>)`}, no quadradinho preto</span><button type="button" class="link" data-acao="cq-cancelar">Cancelar</button></div>`
      : estado.cqDesenho ? `<div class="cq-dica cq-dica-rascunho"><span>✏️ Rascunho: desenhe com um dedo · dois dedos movem</span><button type="button" class="link" data-acao="cq-desfazer">↶ Desfazer</button><button type="button" class="link" data-acao="cq-rascunho">Pronto</button></div>`
      : estado.cqNovo || sel || estado.cqNota ? "" : mover ? `<div class="cq-dica cq-dica-mover"><span>📌 Toque no croqui onde fica o <b>${esc(mover.nome)}</b></span><button type="button" class="link" data-acao="cq-cancelar">Cancelar</button></div>`
      : !o.projeto ? ""
        : soLeitura(o) ? (marcados ? "" : `<div class="cq-dica">Nenhum ponto marcado no croqui.</div>`)
          : analiseHtml(o) || (!marcados ? `<div class="cq-dica">Toque no poste para lançar os serviços dele</div>` : "");
    const baixo = painel ? "" : sel ? folhaPontoCroqui(sel) : estado.cqNota ? folhaNotaCroqui() : estado.cqNovo ? folhaNovoCroqui() : `<div class="cq-barra">
        <div class="rodape-total"><span>Total da obra</span><b>${M.fmtMoeda(t.valor)}</b></div>
        ${o.projeto ? `<button type="button" class="botao botao-claro botao-croqui" data-acao="cq-baixar" ${estado.baixandoCroqui ? "disabled" : ""} title="Baixar o croqui com os pontos, vãos, anotações e rascunho">${estado.baixandoCroqui ? "⏳" : "⬇"} Croqui</button>` : ""}
        <button type="button" class="botao" data-acao="medicao" ${o.pontos.some((p) => p.itens.length) ? "" : "disabled"}>Gerar medição</button>
      </div>`;
    return `<div class="pagina-croqui${painel ? " com-painel" : ""}">
      <header class="cq-topo">
        <button type="button" class="voltar" data-acao="inicio">‹ Obras</button>
        <div class="cq-titulo"><b>Obra ${esc(o.numero)}</b><small>${plural(marcados, "ponto", "pontos")} no croqui${soLeitura(o) ? " · consulta" : ""}</small></div>
        <button type="button" class="link cq-lista" data-acao="obra">☰ Pontos</button>
      </header>
      <div class="cq-area" id="cq-area">
        ${dica}
        ${pags > 1 ? `<div class="cq-folhas">
          <button type="button" data-acao="cq-pag" data-p="${pag - 1}" ${pag <= 1 ? "disabled" : ""} aria-label="Folha anterior">‹</button>
          <span>Folha ${pag} de ${pags}<small>${plural(reais.filter((p) => p.croqui && (p.croqui.pag || 1) === pag).length, "ponto", "pontos")}</small></span>
          <button type="button" data-acao="cq-pag" data-p="${pag + 1}" ${pag >= pags ? "disabled" : ""} aria-label="Próxima folha">›</button>
        </div>` : ""}
        <div class="cq-controles">
          <button type="button" data-acao="cq-zoom" data-f="1.6" aria-label="Aproximar">+</button>
          <button type="button" data-acao="cq-zoom" data-f="0.625" aria-label="Afastar">−</button>
          <button type="button" data-acao="cq-ajustar" aria-label="Folha inteira">⤢</button>
          ${o.projeto ? `<button type="button" class="cq-girar" data-acao="cq-girar" aria-label="Girar o croqui" title="Girar o croqui">⟳</button>` : ""}
          ${o.projeto && !soLeitura(o) ? `<button type="button" class="cq-lapis${estado.cqDesenho ? " ativo" : ""}" data-acao="cq-rascunho" aria-label="Rascunho: desenhar no croqui" aria-pressed="${!!estado.cqDesenho}" title="Rascunho">✏️</button>` : ""}
        </div>
        ${painel}
      </div>
      ${baixo}
    </div>`;
  }

  /** o que foi feito no ponto, embaixo do croqui */
  function folhaPontoCroqui(p) {
    const o = estado.obra;
    const tp = M.totaisPonto(p);
    const secoes = M.OPERACOES.map((op) => {
      const itens = p.itens.filter((i) => i.operacao === op);
      if (!itens.length) return "";
      return `<div class="cq-secao"><small class="secao secao-${op.toLowerCase()}"><span>${SECAO[op]}</span><span>${M.fmtMoeda(M.soma(itens, M.valorItem))}</span></small>
        ${porCategoria(itens, (i) => `<div class="cq-item"><span>${esc(i.descricao)} <small>${esc(i.codigo)}</small></span><b>${M.fmtQtd(i.quantidade)}</b></div>`)}</div>`;
    }).join("");
    const fotos = p.fotos.map((id, k) => {
      const url = estado.miniaturas.get(id);
      return `<button type="button" class="cq-mini" data-acao="cq-foto" data-id="${id}">${url ? `<img src="${url}" alt="Foto ${k + 1} de ${esc(p.nome)}">` : "…"}</button>`;
    }).join("");
    return `<div class="cq-folha" role="dialog" aria-label="Ponto ${esc(p.nome)}">
      <div class="cq-folha-topo">
        <b class="cq-nome">${esc(p.nome)}</b>
        <b class="valor">${M.fmtMoeda(tp.valor)}</b>
        <button type="button" class="remover" data-acao="cq-fechar" aria-label="Fechar">×</button>
      </div>
      <small class="sub">${p.vao ? `📏 ${esc(medidasVao(p) || "metragem não informada")} · ` : ""}${p.dia ? esc(M.fmtDia(p.dia)) + " · " : ""}${plural(p.itens.length, "serviço", "serviços")} · ${p.fotos.length ? "📷 " + p.fotos.length : "sem foto"}${p.croqui ? "" : " · fora do croqui"}</small>
      ${p.obs ? `<p class="cq-obs">${esc(p.obs)}</p>` : ""}
      <div class="cq-corpo">
        ${secoes || `<p class="vazio">Nenhum serviço lançado neste ponto ainda.</p>`}
        ${fotos ? `<div class="cq-fotos">${fotos}</div>` : ""}
      </div>
      <div class="dupla">
        <button type="button" class="botao" data-acao="abrir-ponto" data-id="${p.id}">${soLeitura(o) ? "Abrir o ponto" : "✏️ Lançar serviços e fotos"}</button>
        ${soLeitura(o) ? "" : p.vao ? `<button type="button" class="botao botao-claro" data-acao="cq-ajustar-vao" data-id="${p.id}">↔ Ajustar linha</button>`
          : `<button type="button" class="botao botao-claro" data-acao="cq-mover" data-id="${p.id}">${p.croqui ? "↔ Mudar lugar" : "📌 Marcar no croqui"}</button>`}
      </div>
      ${soLeitura(o) ? "" : `<div class="cq-so-fotos">
        <button type="button" class="botao botao-claro" data-acao="cq-camera" data-id="${p.id}">📷 Tirar foto</button>
      </div>`}
      ${soLeitura(o) ? "" : `<button type="button" class="link cq-excluir" data-acao="cq-excluir" data-id="${p.id}">🗑 Excluir ${p.vao ? "o" : "ponto"} ${esc(p.nome)}</button>`}
    </div>`;
  }

  /** toque num lugar vazio: nome do ponto novo (ou pôr ali um ponto que ainda não tem lugar) */
  function folhaNovoCroqui() {
    const n = estado.cqNovo;
    const soltos = postes(estado.obra).filter((p) => !p.croqui).sort(cmpPonto);
    const nome = (n.nome || "").trim().toUpperCase();
    const jaExiste = !n.editado && nome && postes(estado.obra).find((p) => p.nome.trim().toUpperCase() === nome);
    const vao = n.vao && vaoEntre(estado.obra, n.vao.de, n.vao.para);
    return `<div class="cq-folha" role="dialog" aria-label="Novo ponto">
      <div class="cq-folha-topo"><b>Novo ponto aqui</b><button type="button" class="remover" data-acao="cq-cancelar" aria-label="Cancelar">×</button></div>
      <label class="campo">Nome do ponto
        <input id="cq-nome" value="${esc(n.nome)}" placeholder="P1" autocapitalize="characters" autocomplete="off" maxlength="30">
      </label>
      ${avisoLido(n)}
      <div class="cq-outros">
        ${n.vao ? `<button type="button" class="botao botao-vao" data-acao="cq-vao">📏 Vão ${esc(nomeDoPoste(n.vao.de))}–${esc(nomeDoPoste(n.vao.para))}${vao ? ` <small>(${esc(medidasVao(vao) || "aberto")})</small>` : ""}</button>` : ""}
        <button type="button" class="botao botao-claro botao-nota" data-acao="cq-anotar">📝 Anotar aqui</button>
      </div>
      ${jaExiste ? `<div class="cq-existe">${jaExiste.croqui
        ? `<span>O <b>${esc(jaExiste.nome)}</b> já está marcado no croqui.</span><button type="button" class="botao botao-claro" data-acao="cq-ver" data-id="${jaExiste.id}">Ver o ${esc(jaExiste.nome)}</button>`
        : `<span>O <b>${esc(jaExiste.nome)}</b> já foi lançado e está fora do croqui.</span><button type="button" class="botao" data-acao="cq-usar" data-id="${jaExiste.id}">Marcar o ${esc(jaExiste.nome)} aqui</button>`}</div>` : ""}
      <div class="dupla">
        <button type="button" class="botao botao-claro" data-acao="cq-cancelar">Cancelar</button>
        <button type="button" class="botao" data-acao="cq-criar">Criar e lançar serviços</button>
      </div>
      ${soltos.length ? `<small class="sub">Ou pôr aqui um ponto já lançado que está fora do croqui:</small>
        <div class="cq-soltos">${soltos.map((p) => `<button type="button" class="chip" data-acao="cq-usar" data-id="${p.id}">${esc(p.nome)}</button>`).join("")}</div>` : ""}
    </div>`;
  }

  // anotações prontas (pedido do supervisor em 18/11/2026): um toque põe o texto
  const NOTAS_PRONTAS = ["POSTE SUBSTITUÍDO", "POSTE APROVEITADO", "VÃO SUBSTITUÍDO", "VÃO APROVEITADO"];
  /** anotação aberta embaixo do croqui (nova ou já feita) */
  function folhaNotaCroqui() {
    const n = estado.cqNota;
    const ler = soLeitura(estado.obra);
    return `<div class="cq-folha cq-folha-nota" role="dialog" aria-label="Anotação">
      <div class="cq-folha-topo"><b>📝 Anotação</b><button type="button" class="remover" data-acao="cq-nota-fechar" aria-label="Fechar">×</button></div>
      ${ler ? `<p class="cq-obs">${esc(n.texto)}</p>` : `<label class="campo">O que mudou aqui
        <textarea id="cq-nota-texto" rows="3" maxlength="400" placeholder="Ex.: poste ficou 5 m antes; rede passa do outro lado da rua">${esc(n.texto)}</textarea>
      </label>
      <div class="nota-rapidas" role="group" aria-label="Anotações prontas">
        ${NOTAS_PRONTAS.map((t) => `<button type="button" class="chip nota-rapida" data-acao="nota-rapida" data-texto="${esc(t)}">${esc(t)}</button>`).join("")}
      </div>
      <div class="dupla">
        <button type="button" class="botao botao-claro" data-acao="cq-nota-fechar">Cancelar</button>
        <button type="button" class="botao" data-acao="cq-nota-salvar">Salvar anotação</button>
      </div>
      ${n.id ? `<button type="button" class="link cq-excluir" data-acao="cq-nota-excluir">🗑 Excluir anotação</button>` : ""}`}
    </div>`;
  }

  function atualizarMarcas() {
    if (!visor || estado.tela !== "croqui" || !estado.obra) return;
    const o = estado.obra, pag = estado.cqPag;
    const lista = postes(o)
      .filter((p) => p.croqui && (p.croqui.pag || 1) === pag)
      .map((p) => ({
        id: p.id, nome: p.nome, x: p.croqui.x, y: p.croqui.y,
        classe: [p.itens.length ? "cq-com" : "cq-sem", p.id === estado.cqSel ? "cq-sel" : "", p.id === estado.cqMover ? "cq-movendo" : ""].join(" "),
      }));
    // vãos: linha entre os dois postes e a metragem no meio (o meio segue os postes)
    const linhas = [];
    for (const v of o.pontos.filter((p) => p.vao)) {
      const ra = pontoPorId(v.vao.de)?.croqui, rb = pontoPorId(v.vao.para)?.croqui;
      if (v.vao.linha ? (v.croqui?.pag || 1) !== pag : !ra || !rb || (ra.pag || 1) !== pag || (rb.pag || 1) !== pag) continue;
      // de quadradinho a quadradinho (achado pelo app ou ajustado); sem isso, entre os (P)
      const [a, b] = v.vao.linha ? v.vao.linha.map(([x, y]) => ({ x, y })) : [ra, rb];
      const x = arred((a.x + b.x) / 2), y = arred((a.y + b.y) / 2);
      if (!v.croqui || v.croqui.x !== x || v.croqui.y !== y || (v.croqui.pag || 1) !== pag) v.croqui = { pag, x, y };
      linhas.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, classe: `cq-vao-linha${v.id === estado.cqSel || v.id === estado.cqAjuste?.id ? " cq-vao-sel" : ""}${v.vao.linha ? "" : " cq-vao-solta"}` });
      lista.push({ id: v.id, nome: medidasVao(v) || "vão", x, y, classe: ["cq-vao", v.itens.length ? "cq-com" : "", v.id === estado.cqSel ? "cq-sel" : ""].join(" ") });
    }
    // anotações do campo, em azul
    const an = o.anotacoes || {};
    for (const n of an.notas || []) {
      if (n.pag !== pag) continue;
      const t = n.texto.length > 70 ? n.texto.slice(0, 67) + "…" : n.texto;
      lista.push({ id: `nota:${n.id}`, nome: t, x: n.x, y: n.y, classe: `cq-nota${estado.cqNota?.id === n.id ? " cq-nota-sel" : ""}` });
    }
    visor.marcas(lista);
    visor.camada({ linhas, tracos: (an.tracos || []).filter((t) => t.pag === pag).map((t) => ({ pts: t.pts })) });
    visor.desenhar(estado.cqDesenho && !soLeitura(o) ? terminarTraco : null);
    const n = estado.cqNovo;
    const aj = estado.cqAjuste; // ajustando o vão: o 1º poste tocado fica marcado
    visor.alfinete(n && n.pag === estado.cqPag ? n : aj?.pts.length ? { x: aj.pts[0][0], y: aj.pts[0][1] } : null);
  }

  /** põe o visor na tela do croqui, abre o projeto (baixa do banco se preciso) e marca os pontos */
  async function montarCroqui() {
    const area = document.getElementById("cq-area");
    if (!area) return;
    const v = pegarVisor();
    area.prepend(v.el);
    const o = estado.obra;
    atualizarMarcas();
    if (!o?.projeto) return v.msg("Esta obra ainda não tem o projeto anexado. Toque em ☰ Pontos › Editar para anexar.");
    const sel = pontoPorId(estado.cqSel);
    if (sel?.fotos.length) carregarMiniaturas(sel.fotos);
    const revelar = estado.cqRevelar;
    estado.cqRevelar = false;
    try {
      const proj = await garantirProjeto(o);
      if (estado.obra !== o || estado.tela !== "croqui") return;
      if (!proj) {
        return v.msg(navigator.onLine ? "Não deu para baixar o projeto desta obra. Tente de novo." : "Sem internet: o projeto desta obra ainda não está neste celular.");
      }
      await v.carregar(proj, estado.cqPag, giroDa(o, estado.cqPag));
      if (estado.obra !== o || estado.tela !== "croqui") return;
      if (v.paginas && o.projeto.paginas !== v.paginas) {
        o.projeto.paginas = v.paginas;
        if (estado.cqPag > v.paginas) estado.cqPag = v.paginas;
        if (v.paginas > 1) return render(); // aparece a troca de folha
      }
      atualizarMarcas();
      // leitura dos (P) feita antes da versão 49 (só neste aparelho): passa a ir junto com a obra
      if (!soLeitura(o) && !temRotulos(o) && (await rotulosNaObra(o))) salvarAgora();
      // leitura feita em outro aparelho (o computador, outro celular): vem do banco
      else if (!soLeitura(o) && !temRotulos(o)) {
        rotulosDoBanco(o).then(async (ok) => {
          if (ok && estado.obra?.id === o.id) avisar(`Leitura dos (P) recebida do banco: ${plural(await contarRotulos(o), "(P)", "(P)")} prontos para o toque.`, "ok", 5000);
        });
      }
      // deixa os leitores e a inclinação da folha prontos para o primeiro toque
      if (!soLeitura(o)) setTimeout(() => Croqui.prepararProjeto(proj, estado.cqPag).catch(() => {}), 1500);
      const centrar = pontoPorId(estado.cqCentrar);
      estado.cqCentrar = null;
      if (centrar?.croqui) v.centralizar(centrar.croqui);
      // o ponto escolhido (ou o lugar tocado) não pode ficar embaixo do resumo
      const folha = document.querySelector(".cq-folha");
      const alvo = sel?.croqui || estado.cqNovo;
      if (revelar && alvo && folha) {
        const rf = folha.getBoundingClientRect(), ra = area.getBoundingClientRect();
        const lado = rf.left > ra.left + ra.width / 2; // deitado: resumo à direita
        v.revelar(alvo, lado ? { direita: ra.right - rf.left } : { baixo: ra.bottom - rf.top });
      }
    } catch (e) {
      console.error(e);
      v.msg(e.message || "Não deu para abrir o projeto.");
    }
  }

  function tocouVazio(pos) {
    if (estado.tela !== "croqui") return;
    const o = estado.obra;
    const mover = pontoPorId(estado.cqMover);
    if (mover) {
      mover.croqui = { pag: estado.cqPag, x: arred(pos.x), y: arred(pos.y) };
      estado.cqMover = null;
      estado.cqSel = mover.id;
      estado.cqRevelar = true;
      salvarAgora();
      avisar(`${mover.nome} marcado no croqui.`);
      return render();
    }
    if (estado.cqAjuste) return ajustarVao(estado.cqAjuste, { pag: estado.cqPag, x: pos.x, y: pos.y });
    // painel do ponto aberto: o toque num lugar vazio fecha ele e já abre o "Novo ponto aqui"
    if (estado.cqPainel) { estado.cqPainel = null; estado.cqSel = null; salvarAgora(); }
    // com o resumo de um ponto (ou uma anotação) aberto, o primeiro toque fora só fecha
    if (estado.cqSel || estado.cqNota) { estado.cqSel = null; estado.cqNota = null; return render(); }
    if (soLeitura(o)) return;
    const antes = estado.cqNovo;
    const n = { pag: estado.cqPag, x: arred(pos.x), y: arred(pos.y), nome: antes?.editado ? antes.nome : proximoNome(o), editado: !!antes?.editado };
    n.vao = vaoTocado(n); // tocou na linha entre dois postes: dá para abrir o vão
    estado.cqNovo = n;
    estado.cqRevelar = true;
    if (o.projeto) n.lendo = true;
    render();
    if (o.projeto) lerNomePoste(n);
  }

  /** Lê no projeto o nome do poste em volta do toque (F.P1 → P1) e põe no ponto novo,
   *  se o supervisor ainda não digitou outro. */
  async function lerNomePoste(n) {
    const o = estado.obra;
    let achou = null;
    try {
      const guardado = await rotuloPerto(o, n);
      if (guardado) achou = { nome: guardado.nome, texto: `(${guardado.nome})` };
      else {
        const proj = await garantirProjeto(o);
        if (proj) achou = await Croqui.lerPoste(proj, n);
      }
    } catch (e) {
      console.warn("leitura do nome do poste:", e);
    }
    n.lendo = false;
    n.lido = achou?.texto || "";
    // já emenda a leitura dos serviços deste lugar: ao criar o ponto as sugestões estão prontas
    if (o?.projeto && !soLeitura(o) && sugestaoLigada()) lerSugestoes(o, { pag: n.pag, x: n.x, y: n.y }, achou?.nome || n.nome);
    if (estado.cqNovo !== n || estado.obra !== o) return;
    if (achou && !n.editado) {
      // o mesmo (P1) já marcado em outra folha (outro croqui da obra): este é o "P1-F2"
      const outro = M.pontosReais(o.pontos).find((p) => p.nome.trim().toUpperCase() === achou.nome && p.croqui && (p.croqui.pag || 1) !== n.pag);
      n.nome = outro ? `${achou.nome}-F${n.pag}` : achou.nome;
    }
    // digitando: não refaz a tela (o teclado fecharia), só troca o aviso
    if (n.editado) {
      const aviso = document.getElementById("cq-lido");
      if (aviso) aviso.outerHTML = avisoLido(n);
      return;
    }
    render();
  }

  function avisoLido(n) {
    const t = n.lendo ? "🔎 Lendo o nome do poste no projeto…"
      : n.lido ? `Lido no projeto: <b>${esc(n.lido)}</b>`
        : n.lido === "" ? "Não achei o nome do poste aqui. Toque em cima do nome dele (ex.: F.P1) ou digite." : "";
    return `<small class="sub cq-lido" id="cq-lido">${t}</small>`;
  }

  function tocouMarca(id) {
    if (estado.tela !== "croqui") return;
    if (estado.cqMover) return avisar("Toque num lugar vazio do croqui.", "guardado");
    if (estado.cqAjuste) return avisar("Toque no quadradinho preto do poste, fora dos nomes.", "guardado");
    estado.cqNovo = null;
    if (String(id).startsWith("nota:")) {
      const n = (estado.obra.anotacoes?.notas || []).find((x) => `nota:${x.id}` === id);
      estado.cqSel = null;
      estado.cqNota = n ? { ...n } : null;
      return render();
    }
    estado.cqNota = null;
    // painel aberto: tocar em outro ponto troca o painel para ele
    if (estado.cqPainel && painelLateral()) return abrirPonto(id);
    estado.cqSel = id;
    estado.cqRevelar = true;
    render();
  }

  /** Projeto da obra no aparelho; se está só no banco (obra aberta em outro celular), baixa e guarda. */
  const baixandoProjeto = new Map();
  async function garantirProjeto(o) {
    if (!o?.projeto) return null;
    const local = await Banco.obterProjeto(o.id);
    if (local && local.em === o.projeto.em) return local;
    if (!navigator.onLine || !Nuvem.lerSessao()) return local || null;
    const chave = `${o.id}|${o.projeto.em}`;
    if (!baixandoProjeto.has(chave)) {
      baixandoProjeto.set(chave, (async () => {
        const blob = await Nuvem.baixarProjeto(o.id, o.projeto.tipo);
        const proj = { obraId: o.id, blob, nome: o.projeto.nome, tipo: o.projeto.tipo, em: o.projeto.em, enviado: true };
        await Banco.salvarProjeto(proj);
        return proj;
      })().finally(() => baixandoProjeto.delete(chave)));
    }
    try {
      return await baixandoProjeto.get(chave);
    } catch (e) {
      return local || null;
    }
  }

  /** arquivos escolhidos em "Anexar/Trocar o projeto" ou "Adicionar folhas" (mais de um
   *  croqui: viram um PDF só, uma folha atrás da outra) */
  async function receberProjeto(arquivos, modo = "trocar") {
    if (!arquivos.length) return;
    const ehPdf = (a) => a.type === "application/pdf" || /\.pdf$/i.test(a.name || "");
    if (arquivos.some((a) => !ehPdf(a) && !/^image\//.test(a.type))) return avisar("Escolha o projeto em PDF ou foto/imagem.", "erro");
    if (arquivos.reduce((t, a) => t + a.size, 0) > 45 * 1024 * 1024) return avisar("Arquivos muito grandes (máximo 45 MB juntos).", "erro");
    const arquivo = arquivos[0];
    if (arquivos.length === 1 && modo === "trocar") {
      const pdf = ehPdf(arquivo);
      const tipo = pdf ? "application/pdf" : arquivo.type === "image/png" ? "image/png" : "image/jpeg";
      estado.projetoNovo = { blob: arquivo, nome: arquivo.name || (pdf ? "projeto.pdf" : "projeto.jpg"), tipo, modo };
    } else {
      // adicionar: o projeto atual (o novo ainda sem salvar, ou o guardado) vem primeiro
      const lista = [...arquivos];
      let nomeBase = arquivo.name || "projeto";
      if (modo === "adicionar") {
        const o = estado.obra;
        const atual = estado.projetoNovo || (o.projeto && (await garantirProjeto(o)));
        if (atual?.blob) {
          lista.unshift(new File([atual.blob], atual.nome || "projeto.pdf", { type: atual.tipo || "application/pdf" }));
          nomeBase = atual.nome || nomeBase;
        }
      }
      estado.juntando = true;
      const sec0 = document.getElementById("sec-projeto");
      if (sec0) sec0.innerHTML = projetoHtml(estado.obra);
      try {
        const junto = await Croqui.juntarCroquis(lista);
        // "projeto.pdf + 1 croqui" mais 1 → "+ 2 croquis"
        const jaTinha = Number((/\+ (\d+) croquis?$/.exec(nomeBase) || [])[1] || 0);
        const extras = modo === "adicionar" && lista.length > arquivos.length ? jaTinha + arquivos.length : lista.length - 1;
        estado.projetoNovo = {
          blob: junto.blob, tipo: "application/pdf", paginas: junto.paginas, modo,
          nome: `${nomeBase.replace(/( \+ \d+ croquis?)+$/, "")}${extras ? ` + ${extras} croqui${extras > 1 ? "s" : ""}` : ""}`,
        };
        avisar(`${plural(junto.paginas, "folha", "folhas")} no projeto. Falta salvar.`);
      } catch (e) {
        console.error(e);
        avisar(e.message || "Não deu para juntar os croquis.", "erro");
      }
      estado.juntando = false;
    }
    // número da obra no nome do arquivo (ex.: 0032503206.pdf): preenche se o campo está vazio
    const campo = document.getElementById("f-numero");
    const digitos = (arquivo.name.match(/\d[\d.\-\s]*\d/g) || []).map((d) => d.replace(/\D/g, "")).find(obraValida);
    if (campo && !campo.value && digitos) {
      campo.value = digitos;
      campo.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const sec = document.getElementById("sec-projeto");
    if (sec) sec.innerHTML = projetoHtml(estado.obra);
  }

  function proximoNome(o) {
    const nums = o.pontos.map((p) => /^P(\d+)$/i.exec(p.nome.trim())).filter(Boolean).map((m) => Number(m[1]));
    return `P${(nums.length ? Math.max(...nums) : 0) + 1}`;
  }

  // ---------- ponto
  // rótulo curto do departamento; também vale na busca ("lv cruzeta")
  const SIGLA = { "C&M (LM)": "LM", "C&M (LV)": "LV", "P&LF": "P&LF" };
  const sigla = (dep) => SIGLA[dep] || dep;

  /** Um resultado por departamento + código, com os tipos que existem (instalar, retirar...). */
  function montarGrupos() {
    const mapa = new Map();
    M.SERVICOS.forEach((s) => {
      const k = `${s.departamento}|${s.codigo}`;
      if (!mapa.has(k)) {
        mapa.set(k, {
          chave: k, codigo: s.codigo, descricao: s.descricao, departamento: s.departamento,
          busca: normalizar(`${s.codigo} ${s.descricao} ${sigla(s.departamento)} ${sigla(s.departamento).replace("&", "")}`), opcoes: [],
        });
      }
      mapa.get(k).opcoes.push(s);
    });
    mapa.forEach((g) => g.opcoes.sort((a, b) => M.OPERACOES.indexOf(a.operacao) - M.OPERACOES.indexOf(b.operacao)));
    const ordem = (d) => M.DEPARTAMENTOS.indexOf(d);
    return [...mapa.values()].sort((a, b) => ordem(a.departamento) - ordem(b.departamento));
  }
  const cacheGrupos = new Map(); // limpo quando o catálogo é baixado de novo
  const grupos = () => {
    if (!cacheGrupos.has("todos")) cacheGrupos.set("todos", montarGrupos());
    return cacheGrupos.get("todos");
  };

  function resultadosHtml() {
    const termos = normalizar(estado.busca).split(/\s+/).filter(Boolean);
    if (!termos.length) return "";
    const res = grupos().filter((g) => termos.every((t) => g.busca.includes(t))).slice(0, MAX_RESULTADOS);
    if (!res.length) return `<p class="vazio">Nenhum serviço encontrado.</p>`;
    return `<ul class="resultados">${res.map((g) => `<li><button type="button" data-acao="escolher" data-chave="${esc(g.chave)}"><b>${esc(g.codigo)}</b><span>${esc(g.descricao)}</span><i class="sigla sigla-${esc(sigla(g.departamento).replace("&", "").toLowerCase())}">${esc(sigla(g.departamento))}</i></button></li>`).join("")}</ul>`;
  }

  function campoQtd(valor, attrs, grande = false) {
    return `<div class="setas${grande ? " setas-grande" : ""}">
      <input inputmode="decimal" value="${esc(valor)}" placeholder="0" autocomplete="off" ${attrs}>
      <div><button type="button" aria-label="Aumentar" data-passo="1">▲</button><button type="button" aria-label="Diminuir" data-passo="-1">▼</button></div>
    </div>`;
  }

  // lista pré-definida para o supervisor só tocar (nome curto só na tela; a medição sai com a descrição do catálogo)
  const RAPIDOS = [
    ["Poste e base", [["61600", "CAVA PERFURATRIZ"], ["62261", "CAVA LAVANCA"], ["62177", "CALÇADA"], ["62045", "DEFENSA"], ["62297", "POSTE"]]],
    ["Estruturas MT", [["62184", "CE1"], ["62186", "CE2"], ["62190", "CE3"], ["62195", "CE4"], ["62007", "LOSANGULAR"],
      ["60007", "B1/N1"], ["60067", "B2/N2"], ["60080", "B3/N3"], ["60096", "B4/N4"]]],
    ["Cruzetas", [["64197", "1N/1B"], ["64201", "2N/2B"]]],
    ["Estruturas BT", [["60072", "SI1"], ["62205", "SI3"], ["62211", "SI4"], ["62192", "RA2"], ["64073", "RABICHO"], ["64223", "ARMAÇÃO V1"], ["60002", "AFASTADOR BT"]]],
    ["Transformador", [["62193", "<=40KVA"], ["62183", ">40<=112,5KVA"], ["68125", ">112,5KVA"], ["68000", "COMPONENTE"]]],
    ["Chaves e para-raios", [["62069", "CF FACA"], ["60139", "FS FUSÍVEL"], ["62033", "CARTUCHO"], ["60129", "PRBT"], ["62272", "PRMT"]]],
    ["Emendas e telecom", [["62124", "EMENDA BT"], ["62125", "EMENDA MT"], ["62080", "INTERNET"]]],
    ["Isoladores", [["62093", "ISO POLIMÉRICO"], ["62091", "ISO PILAR"], ["60038", "ISO BASTÃO"]]],
    ["Conectores", [["64097", "AMPACTINHO"], ["62152", "CUNHA"], ["60044", "COMPRESSÃO"], ["60054", "PERFURANTE"], ["60040", "ESTRIBO"], ["64079", "GLV"]]],
    ["Aterramento", [["60006", "ATERR POSTE"], ["60005", "ATERR CPREDE"]]],
    ["Iluminação pública", [["60108", "IP<1,5"], ["60111", "IP>1,5"], ["60113", "RELÉ IP"]]],
    ["Ramal", [["60085", "R CONCÊNTRICO"], ["60087", "R MULTIPLEX"], ["60153", "R SUBTERRÂNEO"], ["64135", "CP REDE"]]],
    // poda pelo catálogo da P&LF (o código existe também na LM)
    ["Poda", [["60131", "PODA P", "P&LF"], ["60133", "PODA M", "P&LF"]]],
  ];
  const DEP_RAPIDOS = "C&M (LM)"; // departamento de quem não diz outro
  // lista da linha viva (passada pelo supervisor em 17/11/2026). Na lista dele vieram 62172,
  // 62089 e 62251, que não existem no catálogo: usados os vizinhos com o mesmo nome
  // (60172 nivelamento protegido >= 120mm, 62086 jumper, 62252 para-raio polimérico).
  const LV_ = "C&M (LV)";
  // ordem pedida pelo supervisor em 18/11/2026: poste, estruturas MT, cruzetas, conexões, chaves
  // e para-raios, nivelamento, equipamentos, outros (isoladores ficam antes de outros)
  const RAPIDOS_LV = [
    ["Poste", [["62311", "POSTE", LV_]]],
    ["Estruturas MT", [["62185", "CE1", LV_], ["62187", "CE2", LV_], ["62191", "CE3", LV_], ["62196", "CE4", LV_],
      ["60061", "B1/N1", LV_], ["60070", "B2/N2", LV_], ["60082", "B3/N3", LV_], ["60098", "B4/N4", LV_], ["64074", "LOSANGULAR", LV_]]],
    ["Cruzetas", [["64199", "1N/1B", LV_], ["64203", "2N/2B", LV_]]],
    ["Conexões", [["60041", "ESTRIBO", LV_], ["64081", "GLV", LV_], ["68008", "COMPRESSÃO", LV_], ["68009", "CUNHA", LV_], ["62086", "JUMPER", LV_],
      ["64105", "FLYING PROTEGIDO", LV_], ["64151", "FLYING NU", LV_]]],
    ["Chaves e para-raios", [["62214", "CF FACA", LV_], ["60140", "FS FUSÍVEL", LV_], ["62031", "CARTUCHO", LV_], ["62252", "PRMT", LV_]]],
    ["Nivelamento de rede", [["62116", "RET PROTEGIDO <120MM", LV_], ["60172", "RET PROTEGIDO >=120MM", LV_], ["62000", "RET CABO NU <=2/0", LV_]]],
    ["Equipamentos", [["64017", "TP", LV_]]],
    ["Isoladores", [["62042", "ISO POLIMÉRICO", LV_], ["62092", "ISO PILAR", LV_], ["60039", "ISO BASTÃO", LV_]]],
    ["Outros", [["68049", "COBERTURA", LV_], ["62154", "CONECT BYPASS", LV_], ["62155", "DESCONECT BYPASS", LV_], ["60310", "CON ELEVAÇÃO", LV_]]],
  ];
  // nome curto: só nos botões da lista (nos lançados, no PDF e na planilha vai a descrição do contrato)
  const NOME_CURTO = new Map([...RAPIDOS, ...RAPIDOS_LV].flatMap(([, itens]) => itens.map(([cod, rot, dep = DEP_RAPIDOS]) => [`${dep}|${cod}`, rot])));
  const nomeNaTela = (i) => NOME_CURTO.get(`${i.departamento}|${i.codigo}`) || i.descricao;

  // qual lista pré-definida está na tela: LM ou LV (fica guardado no aparelho)
  let depRapidos = "LM";
  try { depRapidos = localStorage.getItem("croqui_rapidos") === "LV" ? "LV" : "LM"; } catch (e) { /* sem guardar */ }

  function rapidosHtml(p) {
    const lista = depRapidos === "LV" ? RAPIDOS_LV : RAPIDOS;
    return `<div class="dep-rapidos" role="group" aria-label="Lista pré-definida">
        ${["LM", "LV"].map((d) => `<button type="button" class="dep-rapido${d === depRapidos ? " ativo" : ""}" data-acao="dep-rapidos" data-dep="${d}" aria-pressed="${d === depRapidos}">${d}</button>`).join("")}
      </div>` + lista.map(([grupo, itens]) => `<div class="rapidos-grupo">
      <small class="cat">${esc(grupo)}</small>
      <div class="rapidos">${itens.map(([cod, rot, dep = DEP_RAPIDOS]) => {
        const lancados = p.itens.filter((i) => i.codigo === cod && i.departamento === dep);
        const soma = (ops) => lancados.filter((i) => ops.includes(i.operacao)).reduce((t, i) => t + M.numero(i.quantidade), 0);
        const inst = soma(["INSTALAR", "EXECUTAR"]);
        const ret = soma(["RETIRAR"]);
        const selos = (inst ? `<b class="rapido-qtd q-ins" title="Instalado">${M.fmtQtd(inst)}</b>` : "")
          + (ret ? `<b class="rapido-qtd q-ret" title="Retirado">${M.fmtQtd(ret)}</b>` : "");
        return `<button type="button" class="rapido${lancados.length ? " rapido-usado" : ""}" data-acao="rapido" data-chave="${esc(`${dep}|${cod}`)}" data-rotulo="${esc(rot)}">
          ${esc(rot)}${selos ? `<span class="rapido-qtds">${selos}</span>` : ""}</button>`;
      }).join("")}</div>
    </div>`).join("");
  }

  // ---------- o que o projeto pede no poste
  // O croqui.js lê (OCR) os textos do poste; aqui viram sugestões do catálogo. O supervisor
  // confere e lança: o projeto é o planejado, a medição é o que foi feito.
  const MAIUSC = (t) => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const LM = "C&M (LM)", LV = "C&M (LV)";

  // códigos de estrutura que existem no catálogo (B4, CE4, SI1...): conferem o que o OCR leu
  let codigosEstrutura = null;
  function estruturas() {
    if (!codigosEstrutura) {
      codigosEstrutura = new Set();
      M.SERVICOS.forEach((s) => {
        if (/^ESTRUTURA/.test(MAIUSC(s.descricao))) MAIUSC(s.descricao).split(/[\s/]+/).forEach((t) => /^[A-Z]{1,3}\d[A-Z]?$/.test(t) && codigosEstrutura.add(t));
      });
    }
    return codigosEstrutura;
  }
  /** "SL1" → SI1, "511" → SI1, "SH" → SI1 (o OCR troca I por l/1, S por 5 e lê "I1" como H) */
  function codigoEstrutura(bruto) {
    const conhecidos = estruturas();
    const s = bruto.replace(/^5/, "S");
    const tentativas = [bruto, s, s.replace(/L/g, "I"), s.replace(/^S1/, "SI"), s.replace(/H/g, "I1"), s.replace(/0/g, "O"),
      s.replace(/Z$/, "2"), s.replace(/^CC/, "CE"), s.replace(/^S(\d)$/, "SI$1")]; // "RAZ" → RA2, "CC4" → CE4
    return tentativas.find((t) => conhecidos.has(t)) || null;
  }

  // palavras do projeto → serviço do catálogo
  const PALAVRAS = [
    [/\bRELIGADOR\b/, "Religador", (d) => /^RELIGADOR /.test(d)],
    [/\bDEFENSA\b/, "Defensa", (d) => /^DEFENSA/.test(d)],
    [/\bCAL[CÇ]ADA\b/, "Calçada", (d) => /CALCADA/.test(d)],
    [/\b(TRAFO|TRANSFORMADOR)\b/, "Transformador", (d) => /^TRANSFORMADOR DISTRIBUICAO/.test(d)],
    [/\bPARA-?RAIOS?\b/, "Para-raio", (d) => /^PARA-RAIO/.test(d)],
    [/\bATERRAMENTO\b/, "Aterramento", (d) => /^ATERRAMENTO/.test(d)],
    [/\bCRUZETA\b/, "Cruzeta", (d) => /^CRUZETA/.test(d)],
    [/\bESTAI\b/, "Estai", (d) => /^ESTAI/.test(d)],
    [/\bCHAVE FUSIVEL\b/, "Chave fusível", (d) => /^CHAVE FUSIVEL <=/.test(d)],
    // isolador de suspensão é o isolador bastão (supervisor, 17/11/2026)
    [/\bISOL\w*\.?\s+(DE\s+)?SUSP|\bISOL\w*\.?\s+BAST/, "Isolador de suspensão (bastão)", (d) => /^ISOLADOR BASTAO/.test(d)],
  ];

  /** Serviços do catálogo que servem, de LM e de LV: o projeto é só sugestão, quem
   *  escolhe o departamento é o supervisor (nem sempre se faz como foi projetado). */
  function candidatos(filtro, deps) {
    const junto = [];
    for (const dep of deps) junto.push(...grupos().filter((g) => g.departamento === dep && filtro(MAIUSC(g.descricao))));
    return junto.slice(0, 6);
  }

  /** Quantidade de chave (faca ou fusível) num poste não passa de 9: um "1" na frente é a
   *  borda da caixa que o OCR leu ("13 - 100A - 5H" é 3). */
  const semBorda = (q) => (/^1[1-9]$/.test(q) ? q.slice(1) : q);

  /** a potência cabe na faixa da descrição ("3F > 40 KVA E <= 112,5 KVA", "1F <= 20 KVA")? */
  function naFaixaKva(d, kva) {
    const regras = [...d.matchAll(/(<=|>=|<|>)\s*(\d+(?:[,.]\d+)?)\s*KVA/g)];
    if (!regras.length) return false;
    return regras.every(([, op, v]) => {
      const n = Number(v.replace(",", "."));
      return op === "<=" ? kva <= n : op === "<" ? kva < n : op === ">=" ? kva >= n : kva > n;
    });
  }

  /** { operativo, lista: [{ rotulo, qtd, op, texto, cands }], outros: [texto] } */
  function sugestoesDoProjeto(lido) {
    const deps = [LM, LV];
    const lista = [], outros = [];
    let operativo = "";
    // a mesma caixa em duas linhas: "... E INST. 03" + "ISOL DE SUSPENSÃO" é uma frase só
    const linhas = [];
    for (const l of lido.linhas) {
      const ant = linhas[linhas.length - 1];
      if (ant && ant.cor === l.cor && ant.riscada === l.riscada && /\b\d{1,2}$/.test(MAIUSC(ant.texto).trim()) && /^[A-Z]/.test(MAIUSC(l.texto).trim())) {
        linhas[linhas.length - 1] = { ...ant, texto: `${ant.texto} ${l.texto}` };
      } else linhas.push(l);
    }
    for (const l of linhas) {
      // "APROVEITAR 1-B3": o que já está no poste e fica (não é serviço); o resto da frase
      // ("E INST. 03 ...") continua valendo
      const t = MAIUSC(l.texto).replace(/\bA?\s?P\s?ROVEIT\w*.*?(?=\bE\s+INST|\bINST|$)/, " ");
      if (/LINHA\s*VIVA/.test(t)) { outros.push("LINHA VIVA"); continue; }
      // número sozinho no alto da pilha (118106): número operativo do equipamento
      if (/^\d{5,7}$/.test(t.trim())) { operativo = operativo || t.trim(); continue; }
      // vermelho entra; cinza riscado sai; nota (cinza sem risco) diz pelo verbo
      const op = /\bINST/.test(t) ? "INSTALAR" : /\bRET(IRAR|\.)/.test(t) ? "RETIRAR"
        : l.cor === "vermelho" ? "INSTALAR" : l.riscada ? "RETIRAR" : "";
      const antes = lista.length;
      let repetida = false;
      const por = (rotulo, qtd, filtro, ordem = deps, todos = false) => {
        const cands = candidatos(filtro, ordem, todos);
        // a mesma sugestão de novo (pedaço da linha lido duas vezes): uma basta
        if (cands.length && lista.some((x) => x.rotulo === rotulo && x.op === op && x.qtd === qtd)) { repetida = true; return; }
        if (cands.length) lista.push({ rotulo, qtd, op, texto: l.texto, cands });
        else outros.push(rotulo);
      };
      // poste: DT12/1000 = altura 12 m / 1000 daN (o OCR às vezes perde o D, põe espaço, lê a
      // barra como 1, "DT1211000", ou gruda a borda da caixa na frente, "IDT11/600")
      const mp = /(?:^|[^A-Z0-9]|[IL|[])D?T\s?(\d{1,2})\s?[/1IL|]\s?(\d{3,4})\b/.exec(t);
      if (mp) {
        const alto = Number(mp[1]) > 13;
        por(`Poste ${mp[1]}/${mp[2]}`, "1", (d) => /^POSTE DE CONCRETO/.test(d) && d.includes(alto ? "> 13M" : "<= 13M"));
      }
      // 2-100A-0,5H: chave fusível (2 = quantidade, 100 A, elo 0,5H)
      const fus = /\b(\d{1,2})\s?-\s?(\d{2,3})\s?A\s?[-:]?\s?(\d+(?:[,.]\d+)?)\s?([HKT])\b/.exec(t); // (o OCR troca o traço por ":")
      if (fus) por(`Chave fusível ${fus[2]} A - ${fus[3]}${fus[4]}`, semBorda(fus[1]), (d) => /^CHAVE FUSIVEL <=/.test(d));
      // estruturas: 1-B4, 2-CE4; cruzeta limpa: 1-2B (2N/2M/2B), 1-1B
      for (const m of t.matchAll(/\b(\d{1,2})\s?-\s?([A-Z0-9]{2,4})\b/g)) {
        const cruzeta = /^([12])([NMB])E?$/.exec(m[2]);
        if (cruzeta) {
          // a de concreto LM (64201 para 2B) primeiro, a LV logo abaixo
          por(`Cruzeta limpa ${m[2]}`, m[1], (d) => /^CRUZETA LIMPA CONCRETO/.test(d) && d.split(/[\s/]+/).includes(m[2]), [LM, LV], true);
          continue;
        }
        const cod = codigoEstrutura(m[2]);
        if (cod) por(`Estrutura ${cod}`, m[1], (d) => /^ESTRUTURA/.test(d) && d.split(/[\s/]+/).includes(cod));
        else if (/[A-Z]/.test(m[2]) && !/^\d+A$/.test(m[2])) outros.push(`${m[1]}-${m[2]}`);
      }
      // 9CF - 400 A: chave faca (por fase)
      // (o número às vezes sai como letra, "SCF": aí fica sem quantidade, para digitar)
      const cf = /(?:^|[^A-Z0-9])([0-9OS]{0,2})\s?CF\b/.exec(t);
      if (cf) por(`Chave faca${/400\s?A/.test(t) ? " 400 A" : ""}`, /^\d+$/.test(cf[1]) ? semBorda(cf[1]) : "", (d) => /^CHAVE FACA/.test(d));
      // TR - 3 - 112KVA: transformador, trifásico (3), potência (kVA) → faixa do catálogo
      const tr = /\bTR\s?-?\s?([123])\s?-?\s?(\d+(?:[,.]\d+)?)\s?KVA\b/.exec(t);
      if (tr) {
        const kva = Number(tr[2].replace(",", "."));
        por(`Transformador ${tr[1]}F ${tr[2]} kVA`, "1", (d) => d.startsWith(`TRANSFORMADOR DISTRIBUICAO ${tr[1]}F`) && naFaixaKva(d, kva));
      }
      for (const [re, rotulo, filtro] of PALAVRAS) {
        const m = re.exec(t);
        if (!m) continue;
        // quantidade: o número logo antes ("INST. 03 ISOL DE SUSPENSÃO" = 3); sem número, 1
        const q = /(\d{1,2})\s*$/.exec(t.slice(0, m.index));
        por(rotulo, q ? String(Number(q[1])) : "1", filtro);
      }
      if (lista.length === antes && !repetida && !mp && !cf && !fus && !tr) outros.push(l.texto);
    }
    return { operativo, lista, outros: [...new Set(outros)] };
  }

  // leitura feita uma vez por lugar do ponto e guardada no aparelho: abrir o ponto de novo
  // (até em outro dia) não lê o projeto outra vez. Mudou o leitor → sobe LEITURA e lê de novo.
  const LEITURA = 25;
  const lidosProjeto = new Map();
  // pelo lugar (pode começar no toque do croqui, antes de o ponto existir)
  const chaveLido = (o, croqui) => `${LEITURA}|${o.id}|${o.projeto?.em}|${croqui.pag || 1}|${croqui.x}|${croqui.y}`;
  let guardadosProjeto = null;
  const lidosGuardados = () => (guardadosProjeto = guardadosProjeto || Banco.ler("lidos_projeto", {}).then((g) => g || {}).catch(() => ({})));
  async function guardarLido(k, lido) {
    const g = await lidosGuardados();
    g[k] = { lido, em: Date.now() };
    // só os 300 mais novos
    const ks = Object.keys(g);
    if (ks.length > 300) ks.sort((a, b) => g[a].em - g[b].em).slice(0, ks.length - 300).forEach((x) => delete g[x]);
    Banco.gravar("lidos_projeto", g).catch(() => {});
  }
  /** Lê no projeto os serviços do lugar `croqui` (uma vez só por lugar). Começa já no toque
   *  do croqui, junto com o nome do poste: ao abrir o ponto as sugestões estão prontas. */
  const leiturasEmCurso = new Map();
  function lerSugestoes(o, croqui, nome) {
    const k = chaveLido(o, croqui);
    if (lidosProjeto.has(k)) return leiturasEmCurso.get(k) || Promise.resolve();
    lidosProjeto.set(k, { lendo: true });
    const vez = (async () => {
      let r = { erro: true };
      try {
        const guardado = (await lidosGuardados())[k];
        if (guardado) r = { lido: guardado.lido };
        else {
          const proj = await garantirProjeto(o);
          // o nome do ponto (P2) ajuda a achar o "(P2)" do projeto quando o OCR não lê ele
          // ("P1-F2": o ponto P1 da folha 2; no projeto está escrito "(P1)")
          const lido = proj && await Croqui.lerProjeto(proj, croqui, (nome || "").trim().toUpperCase().replace(/-F\d+$/, ""));
          r = { lido };
          if (proj) guardarLido(k, lido || null);
        }
      } catch (e) {
        console.warn("leitura do projeto:", e);
      }
      lidosProjeto.set(k, r);
      // o ponto deste lugar está aberto: só troca o cartão (refazer a tela fecharia o
      // teclado de quem está digitando). Pelo lugar: a obra pode ter sido recarregada.
      const el = document.getElementById("do-projeto");
      const atual = estado.tela === "ponto" ? ponto() : null;
      if (el && atual?.croqui && estado.obra && chaveLido(estado.obra, atual.croqui) === k) el.outerHTML = doProjetoHtml(estado.obra, atual);
      leiturasEmCurso.delete(k);
    })();
    leiturasEmCurso.set(k, vez);
    return vez;
  }
  function doProjeto(o, p) {
    lerSugestoes(o, p.croqui, p.nome);
    return lidosProjeto.get(chaveLido(o, p.croqui));
  }

  const chaveSug = (x) => `${x.op}|${x.rotulo}`;

  function doProjetoHtml(o, p) {
    if (p.geral || !p.croqui || !o.projeto || soLeitura(o) || !sugestaoLigada()) return "";
    const r = doProjeto(o, p);
    // só o P que identifica o ponto: o "(P1)" do projeto; sem ele, o número do F.P2
    const id = r.lido ? (r.lido.apelido || r.lido.poste).replace(/[()]/g, "").replace(/^[A-Z]{1,3}\.?(?=P)/, "") : "";
    const topo = () => `<div class="linha-topo"><b>📐 No projeto${id ? ` <small>${esc(id)}</small>` : ""}</b></div>`;
    if (r.lendo) return `<section class="cartao do-projeto" id="do-projeto">${topo()}<small class="sub">🔎 Lendo o que o projeto pede neste poste…</small></section>`;
    if (r.erro) return `<section class="cartao do-projeto" id="do-projeto">${topo()}<small class="sub">Não deu para ler o projeto agora${navigator.onLine ? "" : " (o leitor precisa de internet na 1ª vez)"}.</small></section>`;
    let s = { lista: [], outros: [] };
    try {
      if (r.lido) s = sugestoesDoProjeto(r.lido);
    } catch (e) {
      console.warn("sugestões do projeto:", e); // a tela do ponto continua funcionando
    }
    if (!s.lista.length && !s.outros.length && !s.operativo) {
      return `<section class="cartao do-projeto" id="do-projeto">${topo()}<small class="sub">${r.lido ? "O projeto não escreve serviço neste poste." : "Não achei o nome do poste no projeto perto deste ponto."}</small></section>`;
    }
    // o que já foi lançado (em LM ou LV, com o mesmo tipo) sai da sugestão
    const lancado = (g, op) => p.itens.some((i) => i.codigo === g.codigo && i.departamento === g.departamento && (!op || i.operacao === op));
    const pendentes = s.lista.filter((x) => !x.cands.some((g) => lancado(g, x.op)));
    // o supervisor pode ocultar a sugestão que não vai usar (fica guardado no ponto)
    const ocultas = new Set(p.sugOcultas || []);
    const faltam = pendentes.filter((x) => !ocultas.has(chaveSug(x)));
    const nOcultas = pendentes.length - faltam.length;
    const linhas = faltam.map((x) => `<div class="sug">
        <div class="sug-topo">${x.op ? `<span class="sug-op sug-${x.op.toLowerCase()}">${ROTULO[x.op]}</span>` : ""}<b>${x.qtd ? `${esc(x.qtd)} × ` : ""}${esc(x.rotulo)}</b>
          <button type="button" class="sug-ocultar" data-acao="sug-ocultar" data-chave="${esc(chaveSug(x))}" aria-label="Ocultar esta sugestão" title="Ocultar esta sugestão">×</button></div>
        <div class="sug-cands">${x.cands.map((g) => `<button type="button" class="sug-cand" data-acao="sugestao" data-chave="${esc(g.chave)}" data-qtd="${esc(x.qtd)}" data-op="${x.op}">
            <b>${esc(g.codigo)}</b> ${esc(g.descricao)} <i class="sigla sigla-${esc(sigla(g.departamento).replace("&", "").toLowerCase())}">${esc(sigla(g.departamento))}</i></button>`).join("")}</div>
      </div>`).join("");
    const feitos = s.lista.length - pendentes.length;
    return `<section class="cartao do-projeto" id="do-projeto">
      ${topo()}
      ${s.operativo ? `<div class="sug-operativo">Nº operativo <b>${esc(s.operativo)}</b></div>` : ""}
      ${linhas ? `<small class="sub">Toque no serviço para conferir a quantidade e lançar o que foi feito.</small>${linhas}`
        : s.lista.length && !nOcultas ? `<small class="sub">✓ Tudo o que o projeto pede neste poste já foi lançado.</small>` : ""}
      ${linhas && feitos ? `<small class="sub">✓ ${plural(feitos, "sugestão já lançada", "sugestões já lançadas")}.</small>` : ""}
      ${nOcultas ? `<small class="sub">${plural(nOcultas, "sugestão oculta", "sugestões ocultas")} · <button type="button" class="link" data-acao="sug-mostrar">Mostrar</button></small>` : ""}
      ${s.outros.length ? `<small class="sub sug-outros">Também escrito no projeto: ${s.outros.map(esc).join(" · ")}</small>` : ""}
    </section>`;
  }

  /** Lançados nos grupos e na ordem da planilha de fechamento (POSTES, ESTRUTURA CRUZETAS...,
   *  CONEXÕES...): cada grupo com o nome bem pequeno e uma linha fina em cima. */
  function porCategoria(itens, linha) {
    const grupos = new Map();
    for (const i of itens) {
      const c = M.categoria(i.descricao);
      if (!grupos.has(c)) grupos.set(c, []);
      grupos.get(c).push(i);
    }
    return M.ORDEM_CATEGORIAS.filter((c) => grupos.has(c))
      .map((c) => `<div class="cat-divisa"><span>${esc(c)}</span></div>${grupos.get(c).map(linha).join("")}`).join("");
  }

  function telaPonto() {
    const o = estado.obra;
    const p = ponto();
    if (!p) return telaObra();
    const tp = M.totaisPonto(p);
    // pesquisa nos serviços lançados: código, descrição ou nome curto
    const termosItens = normalizar(estado.filtroItens || "").split(/\s+/).filter(Boolean);
    const confere = (i) => !termosItens.length || termosItens.every((x) => normalizar([i.codigo, i.descricao, nomeNaTela(i)].join(" ")).includes(x));
    const achadosItens = p.itens.filter(confere).length;
    const pesquisaItens = p.itens.length >= 4 ? `<label class="campo campo-pesquisa campo-pesquisa-itens"><input id="filtro-itens" type="search" value="${esc(estado.filtroItens || "")}" placeholder="Pesquisar serviço lançado: código ou nome" autocomplete="off"></label>
      ${termosItens.length ? `<small class="sub">${achadosItens ? `${plural(achadosItens, "serviço encontrado", "serviços encontrados")} de ${p.itens.length}` : "Nenhum serviço lançado com essa pesquisa."}</small>` : ""}` : "";
    const secoes = M.OPERACOES.map((op) => {
      const todos = p.itens.filter((i) => i.operacao === op);
      const itens = todos.filter(confere);
      if (!itens.length) return "";
      return `<section class="bloco">
        <h2 class="secao secao-${op.toLowerCase()}"><span>${SECAO[op]} · ${itens.length < todos.length ? `${itens.length} de ${todos.length}` : todos.length}</span><span>${M.fmtMoeda(M.soma(todos, M.valorItem))}</span></h2>
        ${porCategoria(itens, (i) => `<div class="cartao item item-linha">
          <div class="item-nome"><b>${esc(i.descricao)}</b><small>${esc(i.codigo)}</small></div>
          ${campoQtd(i.quantidade, `data-qtd-item="${i.sid}" aria-label="Quantidade de ${esc(i.descricao)}"`)}
          <b class="item-valor" id="valor-${i.sid}">${M.fmtMoeda(M.valorItem(i))}</b>
          <button type="button" class="remover" data-acao="remover-item" data-sid="${i.sid}" aria-label="Remover">×</button>
        </div>`)}
      </section>`;
    }).join("");

    const fotos = p.fotos.map((id, k) => {
      const url = estado.miniaturas.get(id);
      return `<button type="button" class="miniatura" data-acao="ver-foto" data-id="${id}">${url ? `<img src="${url}" alt="Foto ${k + 1}">` : "…"}</button>`;
    }).join("");

    // anterior / próximo só entre os pontos (os serviços da obra ficam fora)
    const lista = M.pontosReais(o.pontos);
    const outros = !p.geral && lista.length > 1;
    const idx = lista.indexOf(p);
    const u = p.gps ? M.utm(p.gps.lat, p.gps.lng) : null;

    return `<div class="pagina pagina-form pagina-larga">
      ${topo(p.geral ? "Serviços da obra" : p.nome, o.projeto ? "croqui" : "obra", `<span class="topo-equipe">Obra ${esc(o.numero)}</span>`)}
      ${outros ? `<div class="navega">
        <button type="button" class="link" data-acao="ponto-ant" ${idx === 0 ? "disabled" : ""}>‹ ${idx > 0 ? esc(lista[idx - 1].nome) : ""}</button>
        <small>${idx + 1} de ${lista.length}</small>
        <button type="button" class="link" data-acao="ponto-prox" ${idx === lista.length - 1 ? "disabled" : ""}>${idx < lista.length - 1 ? esc(lista[idx + 1].nome) : ""} ›</button>
      </div>` : ""}
      <div class="ponto-colunas"><div class="ponto-col">
      <fieldset class="conjunto" ${soLeitura(o) ? "disabled" : ""}>
      <section class="cartao dados">
        ${p.geral ? `<p class="faixa faixa-geral">🧰 <b>Serviços da obra, sem ponto.</b> O que for lançado aqui soma no total da obra e sai na medição como <b>SERVIÇOS GERAIS</b>.</p>` : p.vao ? `<p class="faixa faixa-vao">📏 <b>Vão entre ${esc(nomeDoPoste(p.vao.de))} e ${esc(nomeDoPoste(p.vao.para))}</b></p>
        <div class="vao-campos">
          <label class="campo">De<input id="p-vao-de" list="lista-postes" value="${esc(nomeDoPoste(p.vao.de))}" autocapitalize="characters" autocomplete="off" maxlength="30"></label>
          <label class="campo">Para<input id="p-vao-para" list="lista-postes" value="${esc(nomeDoPoste(p.vao.para))}" autocapitalize="characters" autocomplete="off" maxlength="30"></label>
          <datalist id="lista-postes">${opcoesPostes(o)}</datalist>
        </div>
        <small class="sub">Escolha o poste ou digite outro (ex.: P27A): poste que não existe é criado como extra.</small>
        <label class="campo">Metragem (m)<input id="p-metros" inputmode="decimal" value="${esc(p.vao.metros || "")}" placeholder="Ex.: 35" autocomplete="off"></label>
        ${o.projeto ? `<button type="button" class="link link-remarcar" data-acao="vao-remarcar">📌 Remarcar a linha no croqui</button>` : ""}` : `<label class="campo">Ponto
          <input id="p-nome" value="${esc(p.nome)}" placeholder="P1" autocapitalize="characters" autocomplete="off">
        </label>`}
        <label class="campo"><span>Observação <small>(se tiver)</small></span>
          <textarea id="p-obs" rows="2" placeholder="${p.geral ? "Ex.: serviços do trecho todo" : "Ex.: poste novo 11/300, troca de cruzeta"}">${esc(p.obs)}</textarea>
        </label>
        ${p.geral || p.vao ? "" : `<div class="gps">
          ${u ? `<span class="utm"><small>UTM ${esc(u.zona)}</small> <b>X</b> ${u.x} <b>Y</b> ${u.y} <small>±${Math.round(p.gps.prec || 0)} m</small></span>` : `<span class="sub">Sem coordenada</span>`}
          <button type="button" class="link" data-acao="gps">${p.gps ? "Atualizar" : "📍 Marcar coordenada"}</button>
        </div>`}
        ${p.geral || p.vao || !o.projeto ? "" : `<div class="gps no-croqui">
          ${p.croqui ? `<span>📌 Marcado no croqui${(o.projeto.paginas || 1) > 1 ? ` <small>(folha ${p.croqui.pag || 1})</small>` : ""}</span>` : `<span class="sub">Fora do croqui</span>`}
          <span>${p.croqui ? `<button type="button" class="link" data-acao="ver-no-croqui">Ver</button>` : ""}
          <button type="button" class="link" data-acao="marcar-no-croqui">${p.croqui ? "Mudar lugar" : "📌 Marcar no croqui"}</button></span>
        </div>`}
      </section>
      </fieldset>

      ${doProjetoHtml(o, p)}
      ${p.vao && !soLeitura(o) ? vaoServicosHtml(p) : ""}

      <section class="cartao adicionar" ${soLeitura(o) ? "hidden" : ""}>
        <b>Serviços</b>
        <button type="button" class="link link-busca" data-acao="abrir-busca">${estado.buscaAberta ? "Fechar busca" : "🔎 Outro serviço (buscar no catálogo)"}</button>
        ${estado.buscaAberta ? `<label class="campo">
          <input id="p-busca" type="search" value="${esc(estado.busca)}" placeholder="Código ou nome do serviço" autocomplete="off">
        </label>
        <div id="resultados">${resultadosHtml()}</div>` : ""}
        ${rapidosHtml(p)}
      </section>
      </div><div class="ponto-col">

      <fieldset class="conjunto" ${soLeitura(o) ? "disabled" : ""}>
      ${pesquisaItens}
      ${secoes || (termosItens.length ? "" : `<p class="vazio">Nenhum serviço lançado ${p.geral ? "sem ponto" : "neste ponto"}.</p>`)}
      </fieldset>

      <section class="cartao dados">
        <div class="linha-topo"><b>${p.geral ? "Fotos" : "Fotos do ponto"}</b><small class="sub">${plural(p.fotos.length, "foto", "fotos")}</small></div>
        ${fotos ? `<div class="fotos">${fotos}</div>
        <button type="button" class="link link-galeria" data-acao="fotos-galeria">💾 Salvar ${p.fotos.length === 1 ? "a foto" : `as ${p.fotos.length} fotos`} no celular</button>` : ""}
        <div class="dupla" ${soLeitura(o) ? "hidden" : ""}>
          <button type="button" class="botao" data-acao="camera">📷 Tirar foto</button>
          <input type="file" accept="image/*" capture="environment" data-acao="foto" data-origem="camera" hidden>
          <label class="botao botao-claro">🖼 Galeria<input type="file" accept="image/*" multiple data-acao="foto" data-origem="galeria" hidden></label>
        </div>
      </section>

      ${soLeitura(o) ? "" : `<button type="button" class="botao botao-perigo botao-pequeno" data-acao="excluir-ponto">${p.geral ? "Excluir os serviços sem ponto" : `Excluir ponto ${esc(p.nome)}`}</button>`}
      </div></div>

      <div class="rodape">
        <div class="rodape-total"><span>${p.geral ? "Total sem ponto" : "Total do ponto"}</span><b id="total-ponto">${M.fmtMoeda(tp.valor)}</b></div>
        ${o.projeto ? `<button type="button" class="botao" data-acao="croqui">🗺 ${soLeitura(o) ? "Voltar ao croqui" : p.geral ? "Concluir e voltar ao croqui" : "Concluir ponto e voltar ao croqui"}</button>`
          : `<div class="dupla" ${soLeitura(o) ? "hidden" : ""}>
          <button type="button" class="botao botao-claro" data-acao="obra">${p.geral ? "Concluir" : "Concluir ponto"}</button>
          <button type="button" class="botao" data-acao="novo-ponto">${p.geral ? "+ Novo ponto" : "Próximo ponto ›"}</button>
        </div>`}
      </div>
      ${folhaHtml()}
      ${fotoHtml()}
    </div>`;
  }

  /** os postes da obra para escolher o começo e o fim do vão */
  const opcoesPostes = (o) => postes(o).slice().sort(cmpPonto).map((q) => `<option value="${esc(q.nome)}"></option>`).join("");
  /** Serviços do vão, pré-definidos pelo supervisor (17/11/2026), todos da LM:
   *  [grupo, [[código, nome curto, "esp" (quantidade de espaçadores) ou "m" (metragem)]]] */
  const VAO_RAPIDOS = [
    ["ESPAÇADORES", [["62007", "Losangular", "esp"], ["60058", "Vertical", "esp"]]],
    ["CONDUTOR", [
      ["64228", "Multiplex ≤ 70 mm²", "m"], ["62051", "Multiplex > 70 mm²", "m"],
      ["64229", "Cabo nu ≤ 2/0 BT", "m"], ["64230", "Cabo nu ≤ 2/0 MT", "m"], ["62088", "Cabo nu > 2/0 MT", "m"],
      ["66007", "Protegido ≤ 95 mm²", "m"], ["66005", "Protegido > 95 mm²", "m"], ["62099", "Cordoalha", "m"],
    ]],
    ["RETENCIONAMENTO", [
      ["62263", "Protegido < 120 mm", "m"], ["60026", "Protegido ≥ 120 mm", "m"],
      ["64200", "Multiplex ≤ 70 mm", "m"], ["62141", "Multiplex > 70 mm", "m"],
      ["64208", "Nu ≤ 2/0 MT", "m"], ["64202", "Nu > 2/0 MT", "m"], ["64210", "Nu ≤ 2/0 BT", "m"],
    ]],
  ];
  /** Serviços do vão: os por metro já com a metragem e os espaçadores já com a quantidade
   *  informada. Tocar abre a quantidade para conferir e lançar (instalar ou retirar). */
  function vaoServicosHtml(p) {
    const dep = "C&M (LM)";
    const grupoHtml = ([titulo, itens]) => `<div class="rapidos-grupo">
      <small class="cat">${esc(titulo)}</small>
      <div class="rapidos rapidos-vao">${itens.map(([cod, rot, tipo]) => {
        const porMetro = tipo === "m";
        const qtd = porMetro ? p.vao.metros : ""; // espaçador: a quantidade é digitada na hora
        const lancados = p.itens.filter((i) => i.codigo === cod && i.departamento === dep);
        const soma = (ops) => lancados.filter((i) => ops.includes(i.operacao)).reduce((t, i) => t + M.numero(i.quantidade), 0);
        const inst = soma(["INSTALAR", "EXECUTAR"]), ret = soma(["RETIRAR"]);
        const selos = (inst ? `<b class="rapido-qtd q-ins" title="Instalado">${M.fmtQtd(inst)}</b>` : "") + (ret ? `<b class="rapido-qtd q-ret" title="Retirado">${M.fmtQtd(ret)}</b>` : "");
        return `<button type="button" class="rapido vao-servico${lancados.length ? " rapido-usado" : ""}" data-acao="vao-servico" data-chave="${esc(`${dep}|${cod}`)}" data-rotulo="${esc(rot)}" data-vao-qtd="${tipo}" data-qtd="${esc(qtd || "")}">
          <span>${esc(rot)} <small>${esc(cod)}${porMetro ? " · por m" : ""}</small></span>
          ${porMetro ? `<i class="vao-qtd" data-vao-mostra${qtd ? "" : " hidden"}>${qtd ? `${esc(qtd)} m` : ""}</i>` : ""}
          ${selos ? `<span class="rapido-qtds">${selos}</span>` : ""}</button>`;
      }).join("")}</div>
    </div>`;
    return `<section class="cartao vao-servicos">
      <b>Serviços do vão</b>
      <small class="sub" id="vao-dica">${vaoDica(p)}</small>
      ${VAO_RAPIDOS.map(grupoHtml).join("")}
    </section>`;
  }
  const vaoDica = (p) => (p.vao.metros
    ? `<b>${esc(p.vao.metros)} m</b> já sugeridos no condutor e no retencionamento. Toque para conferir e lançar.`
    : "Digite a metragem: ela já vai para o condutor e o retencionamento. Toque para conferir e lançar.");
  /** a metragem mudou: troca só a quantidade dos botões (o teclado fica) */
  function atualizarBotoesVao(p) {
    document.querySelectorAll('[data-vao-qtd="m"]').forEach((b) => {
      const q = p.vao.metros;
      b.dataset.qtd = q || "";
      const el = b.querySelector("[data-vao-mostra]");
      if (el) { el.textContent = q ? `${q} m` : ""; el.hidden = !q; }
    });
    const dica = document.getElementById("vao-dica");
    if (dica) dica.innerHTML = vaoDica(p);
  }

  async function baixarCroqui() {
    const o = estado.obra;
    if (!o?.projeto || estado.baixandoCroqui) return;
    estado.baixandoCroqui = true;
    render();
    avisar("Montando o croqui…", "guardado");
    try {
      const proj = await garantirProjeto(o);
      if (!proj) throw new Error(navigator.onLine ? "Não deu para baixar o projeto desta obra." : "Sem internet: o projeto desta obra não está neste celular.");
      const total = await Croqui.paginas(proj);
      const an = o.anotacoes || {};
      const naFolha = (c, pag) => c && (c.pag || 1) === pag;
      const folhas = [];
      for (let pag = 1; pag <= total; pag++) {
        const f = {
          pag, giro: giroDa(o, pag),
          marcas: postes(o).filter((p) => naFolha(p.croqui, pag)).map((p) => ({ nome: p.nome, x: p.croqui.x, y: p.croqui.y, cor: p.itens.length ? Croqui.COR_COM : Croqui.COR_SEM })),
          vaos: o.pontos.filter((v) => v.vao && naFolha(v.croqui, pag)).map((v) => {
            const ra = pontoPorId(v.vao.de)?.croqui, rb = pontoPorId(v.vao.para)?.croqui;
            const linha = v.vao.linha || (ra && rb ? [[ra.x, ra.y], [rb.x, rb.y]] : null);
            return { x: v.croqui.x, y: v.croqui.y, linha, texto: `${nomeDoPoste(v.vao.de)}–${nomeDoPoste(v.vao.para)}${medidasVao(v) ? " · " + medidasVao(v) : ""}` };
          }),
          tracos: (an.tracos || []).filter((t) => t.pag === pag).map((t) => t.pts),
          notas: (an.notas || []).filter((n) => n.pag === pag).map((n) => ({ x: n.x, y: n.y, texto: n.texto })),
        };
        // só as folhas com alguma coisa marcada (a 1ª sempre)
        if (pag === 1 || f.marcas.length || f.vaos.length || f.tracos.length || f.notas.length) folhas.push(f);
      }
      const blob = await Croqui.croquiAnotado(proj, folhas, {
        titulo: `Obra ${o.numero}${o.municipio ? " · " + o.municipio : ""}`,
        aoAndar: (f, t) => { if (t > 1 && f < t) avisar(`Montando o croqui… folha ${f + 1} de ${t}`, "guardado"); },
      });
      baixar(blob, `CROQUI OBRA ${o.numero}.pdf`);
      avisar("Croqui baixado.");
    } catch (e) {
      console.error(e);
      avisar(e.message || "Não deu para montar o croqui.", "erro");
    }
    estado.baixandoCroqui = false;
    if (estado.tela === "croqui") render();
  }

  function folhaHtml() {
    const g = estado.escolhido;
    if (!g) return "";
    const p = ponto();
    const qtdOk = M.numero(estado.qtd) > 0;
    const ano = Number((p.dia || hoje()).slice(0, 4));
    // tem Instalar e Retirar e nenhum dos dois lançado: botão do meio lança os dois
    const ins = g.opcoes.find((s) => s.operacao === "INSTALAR"), ret = g.opcoes.find((s) => s.operacao === "RETIRAR");
    const ambos = ins && ret && !p.itens.some((i) => i.sid === ins.id || i.sid === ret.id) && g.opcoes.indexOf(ins) + 1 === g.opcoes.indexOf(ret) ? [ins, ret] : null;
    return `<div class="fundo" data-acao="fechar-folha">
      <div class="folha" data-parar>
        <div class="folha-topo"><b>${esc(g.rotulo || g.codigo)}</b><button type="button" class="remover" data-acao="fechar-folha" aria-label="Fechar">×</button></div>
        <p>${g.rotulo ? `<small class="sub">Código ${esc(g.codigo)}</small>` : `${esc(g.descricao)} <i class="sigla sigla-${esc(sigla(g.departamento).replace("&", "").toLowerCase())}">${esc(sigla(g.departamento))}</i>`}</p>
        <div class="campo">Quantidade ${campoQtd(estado.qtd, `id="qtd-folha" aria-label="Quantidade"`, true)}</div>
        <div class="opcoes${ambos ? " opcoes-ambos" : ""}">
          ${g.opcoes.map((s) => {
            const ja = p.itens.some((i) => i.sid === s.id);
            const valor = M.valorItem({ quantidade: estado.qtd, us: s.us, valor_us: M.valorUS(s.departamento, ano) });
            const botao = `<button type="button" class="opcao opcao-${(s.operacao || "").toLowerCase()}${g.opSugerida === s.operacao ? " opcao-sugerida" : ""}" data-acao="adicionar" data-sid="${s.id}" ${ja || !qtdOk ? "disabled" : ""}>
              ${ja ? "✓ " : ""}${esc(ROTULO[s.operacao] ?? s.operacao)}<small data-valor-op="${s.id}">${qtdOk ? M.fmtMoeda(valor) : ""}</small></button>`;
            // entre Instalar e Retirar: os dois de uma vez, com a mesma quantidade
            return ambos && s === ambos[0] ? botao + `<button type="button" class="opcao-ambos" data-acao="adicionar-ambos" data-sids="${ambos.map((x) => x.id).join(",")}" data-ambos ${qtdOk ? "" : "disabled"} aria-label="Lançar instalar e retirar" title="Lançar instalar e retirar">⇅<small>os dois</small></button>` : botao;
          }).join("")}
        </div>
        ${!qtdOk ? `<small class="folha-dica">Digite a quantidade e escolha o tipo.</small>` : ""}
      </div>
    </div>`;
  }

  function fotoHtml() {
    const f = estado.foto;
    if (!f) return "";
    // todas as fotos do ponto lado a lado: deslizar o dedo troca de foto
    const ids = ponto()?.fotos?.length ? ponto().fotos : [f.id];
    const idx = Math.max(0, ids.indexOf(f.id));
    const varias = ids.length > 1;
    return `<div class="visor">
      <div class="visor-topo">${varias ? `<b id="visor-cont">${idx + 1} de ${ids.length}</b><small>deslize para trocar · toque duplo aproxima</small>` : `<span></span><small>dois dedos ou toque duplo aproxima</small>`}</div>
      <div class="visor-area">
        <div class="visor-fotos" id="visor-fotos">${ids.map((id, k) => `<div class="visor-quadro">
          <img src="${estado.miniaturas.get(id) || ""}" alt="Foto ${k + 1} do ponto" draggable="false"></div>`).join("")}</div>
        ${varias ? `<button type="button" class="visor-seta visor-seta-ant" data-acao="foto-ant" aria-label="Foto anterior">‹</button>
          <button type="button" class="visor-seta visor-seta-prox" data-acao="foto-prox" aria-label="Próxima foto">›</button>` : ""}
      </div>
      <div class="visor-acoes">
        <button type="button" class="botao" data-acao="foto-galeria">💾 Salvar na galeria</button>
        ${soLeitura(estado.obra) ? "<span></span>" : `<button type="button" class="botao botao-perigo" data-acao="excluir-foto">Excluir foto</button>`}
        <button type="button" class="botao botao-claro" data-acao="fechar-foto">Fechar</button>
      </div>
    </div>`;
  }

  // ---------- medição
  function telaMedicao() {
    const o = estado.obra;
    const t = M.totaisObra(o);
    const secoes = M.estrutura(o.pontos);
    const semServico = M.pontosReais(o.pontos).filter((p) => !p.itens.length);
    const semFoto = M.pontosReais(o.pontos).filter((p) => !p.fotos.length);
    const resumo = secoes.map((s) => `<section class="bloco">
      <h2 class="secao secao-${s.op.toLowerCase()}"><span>${esc(s.titulo)}</span><span>${M.fmtMoeda(s.subtotal)}</span></h2>
      ${s.cats.map(([cat, itens]) => `<div class="cartao resumo-cat">
        <small class="cat">${esc(cat)}</small>
        ${itens.map((i) => `<div class="resumo-linha"><b>${esc(i.cod)}</b><span>${esc(i.desc)}</span><span class="q">${M.fmtQtd(i.qtd)}</span><span class="v">${M.fmtMoeda(i.valor)}</span></div>`).join("")}
      </div>`).join("")}
    </section>`).join("");
    const arq = estado.arquivo;
    return `<div class="pagina pagina-form pagina-larga">
      ${topo("Medição", o.projeto ? "croqui" : "obra")}
      <div class="chips">
        <span class="chip-obra"><small>OBRA</small><b>${esc(o.numero)}</b></span>
        <span class="chip chip-total">Total <b>${M.fmtMoeda(t.valor)}</b></span>
        <span class="chip chip-us"><b>${M.fmtNum(t.us)}</b> US</span>
        <span class="chip">Execução <b>${esc(dataExec(o))}</b></span>
      </div>
      ${semServico.length ? `<div class="faixa faixa-guardado">Sem serviço: ${esc(semServico.map((p) => p.nome).join(", "))}. Eles saem só no PDF, com as fotos.</div>` : ""}
      ${semFoto.length ? `<div class="faixa faixa-guardado">Sem foto: ${esc(semFoto.map((p) => p.nome).join(", "))}.</div>` : ""}
      <div class="medicao-colunas"><div class="medicao-col">
      <section class="cartao dados">
        <b>Gerar arquivo</b>
        <p class="sub">Mesma estrutura do fechamento simplificado do Termômetro. A planilha traz também uma aba com a medição de cada ponto; o PDF traz cada ponto com as fotos.</p>
        <div class="gerar">
          <button type="button" class="botao" data-acao="gerar-pdf" ${estado.gerando ? "disabled" : ""}>📄 PDF com fotos</button>
          <button type="button" class="botao botao-claro" data-acao="gerar-xlsx" ${estado.gerando ? "disabled" : ""}>📊 Planilha Excel</button>
          <button type="button" class="botao botao-claro" data-acao="gerar-pdf-sem" ${estado.gerando ? "disabled" : ""}>📄 PDF sem fotos</button>
        </div>
        ${estado.gerando ? `<p class="sub">Gerando… com muitas fotos pode levar alguns segundos.</p>` : ""}
        ${arq ? `<div class="pronto">
          <small>Pronto:</small><b>${esc(arq.nome)}</b><small>${(arq.blob.size / 1024 / 1024).toFixed(2)} MB</small>
          <div class="dupla">
            ${podeCompartilhar(arq) ? `<button type="button" class="botao" data-acao="compartilhar">Compartilhar</button>` : ""}
            <button type="button" class="botao botao-claro" data-acao="baixar">Baixar</button>
          </div>
        </div>` : ""}
      </section>
      </div><div class="medicao-col">
      <h2 class="titulo-resumo">Conferência</h2>
      ${resumo}
      </div></div>
    </div>`;
  }
  const dataExec = (o) => {
    const dias = o.pontos.filter((p) => p.itens.length && p.dia).map((p) => p.dia).sort();
    return dias.length ? M.fmtDia(dias[dias.length - 1]) : "—";
  };
  const arquivoDe = (a) => new File([a.blob], a.nome, { type: a.blob.type });
  const podeCompartilhar = (a) => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [arquivoDe(a)] })); } catch (e) { return false; }
  };

  // ------------------------------------------------------------------ fotos
  async function abrirImagem(arquivo) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(arquivo, { imageOrientation: "from-image" }); } catch (e) { /* tenta pelo <img> */ }
    }
    return new Promise((ok, falha) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => falha(new Error("Imagem inválida"));
      img.src = URL.createObjectURL(arquivo);
    });
  }

  /** Desenha a foto no tamanho pedido com a faixa da obra, do ponto, da data/hora e da coordenada. */
  async function carimbar(img, max, qualidade, linhas) {
    const esc1 = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.width * esc1);
    cv.height = Math.round(img.height * esc1);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    return carimbarCanvas(cv, qualidade, linhas);
  }

  /** Faixa com obra, ponto, data/hora e coordenada sobre a foto já desenhada; devolve o JPEG. */
  async function carimbarCanvas(cv, qualidade, linhas) {
    const w = cv.width, h = cv.height;
    const ctx = cv.getContext("2d");
    const fs = Math.max(14, Math.round(Math.min(w, h) * 0.032));
    const alt = fs * 1.35 * linhas.length + fs * 0.6;
    // faixa preta sólida: ao refazer (ponto renomeado, UTM nova) cobre a escrita antiga por inteiro
    const topo = Math.max(0, Math.floor(h - alt) - 1);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, topo, w, h - topo);
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textBaseline = "top";
    linhas.forEach((t, k) => ctx.fillText(t, fs * 0.6, h - alt + fs * 0.3 + k * fs * 1.35));
    const blob = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", qualidade));
    return { blob, largura: w, altura: h, faixa: linhas.join("\n") };
  }

  /** Reduz a foto e grava na parte de baixo a obra, o ponto, a data/hora e o GPS.
   *  Com `copia`, devolve também uma versão maior para guardar na galeria do celular. */
  async function prepararFoto(arquivo, o, p, { copia = false } = {}) {
    const img = await abrirImagem(arquivo);
    const agora = new Date();
    const app = await carimbar(img, FOTO_MAX, 0.78, linhasCarimbo(o, p, agora));
    if (img.close) img.close();
    // a cópia do celular é a mesma foto do app: nada de processar duas vezes
    return { ...app, criada_em: agora.toISOString(), copia: copia ? app.blob : null };
  }

  // ---------------------------------------------------------------- cópia na galeria do celular
  const ehIos = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const copiaLigada = () => {
    try { return localStorage.getItem("croqui_copia_fotos") !== "nao"; } catch (e) { return true; }
  };
  /** Sugestão dos serviços pelo projeto: TIRADA a pedido do supervisor (17/11/2026). O croqui
   *  só lê o (P) de cada poste; os serviços são lançados pela lista e pela busca. O código da
   *  leitura dos serviços fica guardado: para voltar, é só esta função devolver true. */
  const sugestaoLigada = () => false;
  const doisDig = (n) => String(n).padStart(2, "0");
  function nomeFoto(o, p, iso, k = 0) {
    const d = new Date(iso);
    const quando = `${d.getFullYear()}${doisDig(d.getMonth() + 1)}${doisDig(d.getDate())}_${doisDig(d.getHours())}${doisDig(d.getMinutes())}${doisDig(d.getSeconds())}`;
    return `OBRA_${o.numero}_${String(p.nome).replace(/[^\w-]+/g, "")}_${quando}${k ? "_" + k : ""}.jpg`;
  }
  /** Fotos para a galeria: no iPhone abre o compartilhar (Salvar imagem); no Android baixa
   *  para a pasta Download, que aparece na galeria. Precisa vir de um toque na tela. */
  async function guardarNoCelular(arquivos) {
    const files = arquivos.map((a) => new File([a.blob], a.nome, { type: "image/jpeg" }));
    try {
      if (navigator.canShare && navigator.canShare({ files }) && (ehIos() || files.length > 1)) {
        await navigator.share({ files, title: "Fotos da medição" });
        return true;
      }
    } catch (e) {
      if (e.name === "AbortError") return false;
    }
    arquivos.forEach((a, k) => setTimeout(() => baixar(a.blob, a.nome), k * 400));
    return true;
  }

  // ---------------------------------------------------------------- câmera dentro do app
  /* Abre a câmera uma vez e cada toque no disparador congela o quadro na hora; o carimbo,
     a compressão e a gravação acontecem por trás, em fila, sem travar o próximo disparo.
     Sem câmera disponível (permissão negada, aparelho antigo), cai na câmera do celular. */
  const linhasCarimbo = (o, p, quando) => [
    `OBRA ${o.numero} · ${p.nome}`,
    `${quando.toLocaleDateString("pt-BR")} ${quando.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}${p.gps ? ` · ${M.fmtUtm(p.gps)}` : ""}`,
  ];

  /* O nome do ponto, a UTM ou o número da obra mudou depois da foto: refaz a faixa escrita
     nas fotos já tiradas (a nova é preta e cobre a antiga; data e hora continuam as da foto)
     e marca a foto para subir de novo ao banco, por cima da antiga. */
  let filaFaixas = Promise.resolve();
  function refazerFaixas(o, pontos) {
    if (!o || soLeitura(o)) return filaFaixas;
    const lista = pontos.filter((p) => p.fotos.length);
    if (!lista.length) return filaFaixas;
    filaFaixas = filaFaixas.then(() => refazerFaixasAgora(o, lista)).catch((e) => console.error(e));
    return filaFaixas;
  }
  async function refazerFaixasAgora(o, pontos) {
    let n = 0;
    for (const p of pontos) {
      for (const id of [...p.fotos]) {
        const f = await fotoLocal(o, id);
        if (!f?.blob) continue;
        const linhas = linhasCarimbo(o, p, new Date(f.criada_em || Date.now()));
        if (f.faixa === linhas.join("\n")) continue; // já está certa
        const img = await abrirImagem(f.blob);
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        cv.getContext("2d").drawImage(img, 0, 0);
        if (img.close) img.close();
        const pronta = await carimbarCanvas(cv, 0.85, linhas);
        Object.assign(f, pronta, { gps: p.gps || null, faixa_em: new Date().toISOString(), enviada: false });
        await Banco.salvarFoto(f);
        const antiga = estado.miniaturas.get(id);
        if (antiga) {
          estado.miniaturas.set(id, URL.createObjectURL(f.blob));
          setTimeout(() => URL.revokeObjectURL(antiga), 60000); // a tela pode ainda estar mostrando
        }
        n++;
      }
    }
    if (!n) return;
    // a obra volta a ficar pendente para as fotos refeitas subirem
    if (estado.obra?.id === o.id) await salvarAgora();
    else {
      const atual = await Banco.obterObra(o.id);
      if (atual) { await Banco.salvarObra(atual); enviarDepois(); }
    }
    if (estado.obra?.id === o.id && !estado.escolhido && !document.activeElement?.matches?.("input, textarea")) render();
    avisar(n > 1 ? `Nome e UTM atualizados em ${n} fotos.` : "Nome e UTM atualizados na foto.");
  }

  /** câmera do próprio celular; a entrada fica fora da tela para não sumir quando a tela é redesenhada */
  function cameraDoCelular() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.setAttribute("capture", "environment");
    inp.hidden = true;
    inp.addEventListener("change", () => {
      const arquivos = [...inp.files];
      inp.remove();
      if (arquivos.length) receberFotos(arquivos, "camera");
    });
    document.body.appendChild(inp);
    inp.click();
  }

  async function abrirCamera() {
    const o = estado.obra, p = ponto();
    if (!p || !navigator.mediaDevices?.getUserMedia) return cameraDoCelular();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1920 } },
      });
    } catch (e) {
      avisar("Abrindo a câmera do celular…", "guardado");
      return cameraDoCelular();
    }
    const el = document.createElement("div");
    el.className = "camera";
    el.innerHTML = `<video playsinline autoplay muted></video><div class="camera-clarao"></div>
      <div class="camera-topo"><b>${esc(p.nome)}</b><span class="camera-cont">0 fotos</span>
        <button type="button" class="camera-lanterna" data-cam="lanterna" hidden aria-label="Lanterna">🔦</button></div>
      <div class="camera-zoom" hidden></div>
      <div class="camera-base">
        <div class="camera-mini"></div>
        <button type="button" class="camera-disparo" data-cam="foto" aria-label="Tirar foto"></button>
        <button type="button" class="camera-ok" data-cam="ok">Concluir</button>
      </div>`;
    document.body.appendChild(el);
    document.body.classList.add("com-camera");
    const video = el.querySelector("video");
    video.srcObject = stream;
    video.play().catch(() => {});
    let trilha = stream.getVideoTracks()[0];
    let lanterna = false;
    const conferirLanterna = () => {
      const b = el.querySelector(".camera-lanterna");
      lanterna = false;
      b.classList.remove("ligada");
      try { b.hidden = !trilha.getCapabilities?.().torch; } catch (e) { b.hidden = true; }
    };
    conferirLanterna();

    /* Zoom manual: barra embaixo da imagem e pinça com dois dedos na imagem.
       Se a câmera do celular tem zoom, usa o dela (foto com qualidade cheia);
       se não tem, o app aproxima a imagem e a foto sai recortada no centro. */
    let zoom = 1, zoomMin = 1, zoomMax = 3, zoomDaCamera = false; // zoom do app até 3x: mais que isso a foto perde muito detalhe
    let zoomPendente = null, zoomAplicando = false, pincouEm = 0;
    const fmtZoom = (v) => `${(Math.round(v * 10) / 10).toFixed(1).replace(".", ",")}x`;
    async function aplicarZoomCamera() {
      if (zoomAplicando) return;
      zoomAplicando = true;
      while (zoomPendente !== null) {
        const v = zoomPendente;
        zoomPendente = null;
        try { await trilha.applyConstraints({ advanced: [{ zoom: v }] }); } catch (e) { /* segue com o último que deu */ }
      }
      zoomAplicando = false;
    }
    function definirZoom(v) {
      zoom = Math.min(zoomMax, Math.max(zoomMin, Math.round(v * 10) / 10));
      const barra = el.querySelector(".camera-zoom input");
      if (barra && Number(barra.value) !== zoom) barra.value = zoom;
      const rotulo = el.querySelector(".camera-zoom-valor");
      if (rotulo) rotulo.textContent = fmtZoom(zoom);
      if (zoomDaCamera) { zoomPendente = zoom; aplicarZoomCamera(); }
      else video.style.transform = zoom > 1 ? `scale(${zoom})` : "";
    }
    function montarZoom() {
      let caps = {};
      try { caps = trilha.getCapabilities?.() || {}; } catch (e) { /* sem suporte */ }
      const z = caps.zoom;
      if (z && z.max > Math.max(1, z.min)) {
        zoomDaCamera = true;
        zoomMin = Math.max(1, z.min); // sem 0.5x
        zoomMax = Math.min(10, z.max);
      }
      const caixa = el.querySelector(".camera-zoom");
      caixa.innerHTML = `<button type="button" class="camera-zoom-valor" data-cam="zoom1" aria-label="Voltar para 1x">1,0x</button>
        <input type="range" min="${zoomMin}" max="${zoomMax}" step="0.1" value="${zoomMin}" aria-label="Zoom">`;
      caixa.hidden = false;
      caixa.querySelector("input").addEventListener("input", (e) => definirZoom(Number(e.target.value)));
      definirZoom(zoomMin);
    }
    // pinça com dois dedos na imagem
    let pinca = null;
    const distancia = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    video.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) pinca = { d0: distancia(e.touches), z0: zoom };
    }, { passive: true });
    video.addEventListener("touchmove", (e) => {
      if (!pinca || e.touches.length !== 2) return;
      e.preventDefault();
      definirZoom(pinca.z0 * (distancia(e.touches) / pinca.d0));
      pincouEm = Date.now();
    }, { passive: false });
    video.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinca = null; }, { passive: true });
    // o botão voltar do celular fecha a câmera em vez de sair do app
    history.pushState({ camera: true }, "");
    const voltar = () => concluir(false);
    window.addEventListener("popstate", voltar);

    let fila = Promise.resolve();
    const tiradas = [];
    let tiradasN = 0;
    let fechando = false;
    montarZoom();

    function disparar() {
      const w0 = video.videoWidth, h0 = video.videoHeight;
      if (!w0 || fechando) return;
      // congela o quadro agora (rápido); o resto vai para a fila
      // zoom do app: recorta o centro do quadro (o da câmera já vem aproximado)
      const corte = zoomDaCamera ? 1 : zoom;
      const sw = w0 / corte, sh = h0 / corte;
      const esc1 = Math.min(1, FOTO_MAX / Math.max(sw, sh));
      const cv = document.createElement("canvas");
      cv.width = Math.round(sw * esc1);
      cv.height = Math.round(sh * esc1);
      cv.getContext("2d").drawImage(video, (w0 - sw) / 2, (h0 - sh) / 2, sw, sh, 0, 0, cv.width, cv.height);
      const quando = new Date();
      tiradasN++;
      el.querySelector(".camera-cont").textContent = plural(tiradasN, "foto", "fotos");
      const clarao = el.querySelector(".camera-clarao");
      clarao.classList.remove("piscar");
      void clarao.offsetWidth;
      clarao.classList.add("piscar");
      try { navigator.vibrate?.(25); } catch (e) { /* sem vibração */ }
      fila = fila.then(async () => {
        try {
          const pronta = await carimbarCanvas(cv, 0.8, linhasCarimbo(o, p, quando));
          const foto = { id: novoId(), obraId: o.id, pontoId: p.id, gps: p.gps || null, ...pronta, criada_em: quando.toISOString(), origem: "camera", na_galeria: false };
          await Banco.salvarFoto(foto);
          p.fotos.push(foto.id);
          const url = URL.createObjectURL(foto.blob);
          estado.miniaturas.set(foto.id, url);
          tiradas.push({ foto, nome: nomeFoto(o, p, foto.criada_em, tiradas.length) });
          const mini = el.querySelector(".camera-mini");
          mini.innerHTML = `<img src="${url}" alt="Última foto"><small>${tiradas.length}</small>`;
          salvarDepois(); // a obra sobe para o banco logo depois
        } catch (e) {
          console.error(e);
          avisar("Uma foto não pôde ser guardada.", "erro");
        }
      });
    }

    async function concluir(viaBotao = true) {
      if (fechando) return;
      fechando = true;
      window.removeEventListener("popstate", voltar);
      if (viaBotao) history.back();
      el.querySelector(".camera-ok").textContent = "Guardando…";
      await fila;
      stream.getTracks().forEach((t) => t.stop());
      el.remove();
      document.body.classList.remove("com-camera");
      await salvarAgora();
      render();
      if (!tiradas.length) return;
      // cópias no celular só agora, para os avisos de download não atrapalharem os disparos
      if (copiaLigada() && !ehIos()) {
        tiradas.forEach((t, k) => setTimeout(() => baixar(t.foto.blob, t.nome), k * 250));
        for (const t of tiradas) { t.foto.na_galeria = true; await Banco.salvarFoto(t.foto); }
      }
      avisar(`${plural(tiradas.length, "foto guardada", "fotos guardadas")}.`);
    }

    el.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-cam]");
      if (!b) return;
      if (b.dataset.cam === "foto") return disparar();
      if (b.dataset.cam === "ok") return concluir(true);
      if (b.dataset.cam === "zoom1") return definirZoom(zoomMin);
      if (b.dataset.cam === "lanterna") {
        lanterna = !lanterna;
        try { await trilha.applyConstraints({ advanced: [{ torch: lanterna }] }); b.classList.toggle("ligada", lanterna); } catch (err) { /* sem lanterna */ }
      }
    });
    // tocar na imagem também tira a foto (menos logo depois de pinçar o zoom)
    video.addEventListener("click", () => { if (Date.now() - pincouEm > 500) disparar(); });
  }

  // ---------------------------------------------------------------- espaço no celular
  /* O limite é o do celular: o navegador libera para o app até 60% do espaço do aparelho
     (Android/Chrome). Com a guarda permanente, ele não apaga nada sozinho quando o
     espaço aperta. Foto tirada fica sempre guardada no app: só sai se o supervisor
     excluir a foto, o ponto ou a obra. */
  const fmtTamanho = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace(".", ",")} GB`
    : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  async function mostrarEspaco() {
    const el = document.getElementById("espaco");
    if (!el) return;
    const [esp, perm, todas] = await Promise.all([Banco.espaco(), Banco.persistente(), Banco.todasFotos()]);
    // conta por baixo: no mínimo 250 KB por foto (foto real de campo fica entre 200 e 700 KB)
    const medias = Math.max(250 * 1024, todas.length ? todas.reduce((t, f) => t + (f.blob?.size || 0), 0) / todas.length : 0);
    const resta = esp ? Math.max(0, esp.quota - esp.usage) : 0;
    estado.espacoHtml = `${esp ? `<div class="espaco-barra"><i style="width:${Math.min(100, (esp.usage / esp.quota) * 100).toFixed(1)}%"></i></div>
        <p class="sub"><b>${fmtTamanho(esp.usage)}</b> usados de <b>${fmtTamanho(esp.quota)}</b> que o celular libera para o app · cabem ainda cerca de <b>${Math.floor(resta / medias).toLocaleString("pt-BR")} fotos</b>.</p>` : `<p class="sub">Este celular não informa o espaço.</p>`}
      <p class="sub">${todas.length.toLocaleString("pt-BR")} fotos guardadas no app. ${perm ? "✓ Guarda permanente: o celular não apaga nada sozinho." : "⚠ O celular ainda não deu a guarda permanente. Instale o app na tela inicial para garantir."}</p>`;
    const atual = document.getElementById("espaco");
    if (atual) atual.innerHTML = estado.espacoHtml;
  }
  /** aviso na tela inicial quando o espaço do app passa de 85% */
  async function conferirEspaco() {
    const esp = await Banco.espaco();
    estado.espacoApertado = !!(esp && esp.quota && esp.usage / esp.quota > 0.85);
  }

  async function receberFotos(arquivos, origem = "galeria") {
    const o = estado.obra, p = ponto();
    if (!arquivos.length || !p) return;
    avisar(arquivos.length > 1 ? `Guardando ${arquivos.length} fotos…` : "Guardando foto…", "guardado");
    // foto tirada agora pela câmera não fica na galeria sozinha: o app guarda uma cópia
    // (a escolhida da galeria já está lá). No iPhone isso só dá com um toque: botão no ponto.
    const copiar = origem === "camera" && copiaLigada() && !ehIos();
    let ok = 0;
    for (const a of arquivos) {
      try {
        const { copia, ...pronta } = await prepararFoto(a, o, p, { copia: copiar });
        // a cópia sai na hora, antes de guardar, para o celular já ir salvando
        if (copia) baixar(copia, nomeFoto(o, p, pronta.criada_em, ok));
        const foto = { id: novoId(), obraId: o.id, pontoId: p.id, gps: p.gps || null, ...pronta, origem, na_galeria: origem === "galeria" || !!copia };
        await Banco.salvarFoto(foto);
        p.fotos.push(foto.id);
        estado.miniaturas.set(foto.id, URL.createObjectURL(foto.blob));
        ok++;
      } catch (e) {
        console.error(e);
      }
    }
    await salvarAgora();
    render();
    const msg = ok === arquivos.length ? (ok > 1 ? `${ok} fotos guardadas` : "Foto guardada") : `Guardadas ${ok} de ${arquivos.length} fotos`;
    avisar(`${msg}.`, ok ? "ok" : "erro");
  }

  function marcarGps() {
    const p = ponto();
    if (!navigator.geolocation) return avisar("Este aparelho não informa a localização.", "erro");
    avisar("Buscando a localização…", "guardado");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        p.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, prec: pos.coords.accuracy, em: new Date().toISOString() };
        salvarAgora();
        render();
        avisar("Localização marcada.");
        refazerFaixas(estado.obra, [p]);
      },
      () => avisar("Não foi possível pegar a localização. Confira se o GPS está ligado e permitido.", "erro"),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 },
    );
  }

  // ------------------------------------------------------------------ ações
  function novaObra() {
    estado.obra = {
      id: novoId(), numero: "", local: "", municipio: "", equipe: "", obs: "",
      departamento: null,
      pontos: [], criada_em: null,
    };
    irPara("obra-form");
  }

  async function salvarObraForm() {
    const o = estado.obra;
    const v = (id) => document.getElementById(id).value.trim();
    const numero = v("f-numero").replace(/\D/g, "");
    const erro = document.getElementById("erro-form");
    if (!obraValida(numero)) {
      erro.textContent = "O número da obra deve ter 8 ou 10 dígitos.";
      erro.hidden = false;
      return;
    }
    const repetida = (await Banco.listarObras()).find((x) => x.numero === numero && x.id !== o.id);
    if (repetida && !confirm(`Já existe a obra ${numero} neste celular. Criar outra com o mesmo número?`)) return;
    const nova = !o.criada_em;
    const mudouNumero = !nova && o.numero !== numero;
    Object.assign(o, { numero, municipio: v("f-municipio"), obs: v("f-obs") });
    if (nova) {
      o.criada_em = new Date().toISOString();
      o.dono_id = estado.perfil?.user_id || null;
    }
    const pn = estado.projetoNovo;
    if (pn) {
      // o arquivo fica guardado no celular e sobe junto com a obra
      const em = new Date().toISOString();
      try {
        await Banco.salvarProjeto({ obraId: o.id, blob: pn.blob, nome: pn.nome, tipo: pn.tipo, em, enviado: false });
      } catch (e) {
        avisar("Não foi possível guardar o projeto no celular. Libere espaço.", "erro");
        return;
      }
      // folhas acrescentadas: as que já existiam continuam giradas como estavam
      const giros = pn.modo === "adicionar" && o.projeto?.giros ? { giros: o.projeto.giros } : {};
      o.projeto = { nome: pn.nome, tipo: pn.tipo, tamanho: pn.blob.size, em, ...(pn.paginas ? { paginas: pn.paginas } : {}), ...giros };
      if (pn.modo !== "adicionar") o.anotacoes = null; // projeto trocado: as anotações eram do antigo
      o.rotulos = null; // arquivo novo (até com folhas acrescentadas): os (P) são lidos de novo
      estado.projetoNovo = null;
      estado.cqPag = 1;
    }
    await salvarAgora();
    Banco.pedirPersistencia();
    irPara(o.projeto && (nova || pn) ? "croqui" : "obra");
    if (mudouNumero) refazerFaixas(o, o.pontos);
    // projeto novo: análise geral (acha os pontos e lê as sugestões de todos)
    if (pn) setTimeout(() => pedirAnalise(o), 300);
  }

  /** `nome` e `croqui` ({ pag, x, y }) quando o ponto nasce de um toque no croqui */
  function novoPonto({ nome = null, croqui = null } = {}) {
    const o = estado.obra;
    const p = { id: novoId(), nome: nome || proximoNome(o), dia: hoje(), obs: "", gps: null, croqui, itens: [], fotos: [] };
    o.pontos.push(p);
    salvarAgora();
    abrirPonto(p.id);
    marcarGpsSilencioso(p);
  }

  function marcarGpsSilencioso(p) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (p.gps) return;
        p.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, prec: pos.coords.accuracy, em: new Date().toISOString() };
        salvarAgora();
        if (vendoPonto() && estado.pontoId === p.id) render();
        // foto tirada antes de a localização chegar ganha a UTM na faixa
        if (estado.obra?.pontos.includes(p)) refazerFaixas(estado.obra, [p]);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    );
  }

  function adicionarItem(sid) {
    return adicionarItens([sid]);
  }
  /** lança os serviços (instalar e/ou retirar do mesmo código) com a quantidade digitada */
  function adicionarItens(sids) {
    const p = ponto();
    if (M.numero(estado.qtd) <= 0) return;
    if (!p.dia) p.dia = hoje(); // ponto achado no projeto: a data é a do 1º serviço lançado
    const ano = Number((p.dia || hoje()).slice(0, 4));
    let algum = false;
    for (const sid of sids) {
      const s = M.POR_ID.get(sid);
      if (!s || p.itens.some((i) => i.sid === sid)) continue;
      p.itens.push({
        sid: s.id, codigo: s.codigo, descricao: s.descricao, operacao: s.operacao, departamento: s.departamento,
        us: s.us, valor_us: M.valorUS(s.departamento, ano), quantidade: estado.qtd,
      });
      algum = true;
    }
    if (!algum) return;
    salvarAgora();
    estado.qtd = "";
    // código com instalar e retirar continua aberto para lançar o outro tipo
    const faltam = estado.escolhido.opcoes.filter((o) => !p.itens.some((i) => i.sid === o.id));
    if (!faltam.length) estado.escolhido = null;
    render();
  }

  async function gerar(tipo) {
    estado.gerando = true;
    estado.arquivo = null;
    render();
    try {
      // a medição é do que foi feito: os pontos achados no projeto e ainda sem nada lançado
      // (serviço, foto ou observação) ficam de fora da planilha, do PDF e do croqui do PDF
      const o = { ...estado.obra, pontos: estado.obra.pontos.filter((p) => p.itens.length || p.fotos.length || (p.obs || "").trim()) };
      if (tipo === "pdf") {
        // fotos que estão só no banco: baixa antes de montar o PDF
        let faltando = 0;
        for (const id of o.pontos.flatMap((p) => p.fotos)) if (!(await fotoLocal(o, id))) faltando++;
        if (faltando) avisar(`${plural(faltando, "foto não pôde ser baixada", "fotos não puderam ser baixadas")}: o PDF sai sem elas.`, "erro");
      }
      const supervisor = soLeitura(o) ? o.supervisor_nome || "" : estado.perfil?.nome || "";
      // PDF: folha do croqui com os pontos e, com fotos, o pedaço do croqui de cada ponto
      let croqui = null;
      if (tipo !== "xlsx" && o.projeto) {
        try {
          const proj = await garantirProjeto(o);
          if (proj) croqui = await Croqui.paraPdf(o, proj, { recortes: tipo === "pdf" });
          else avisar("O projeto não está neste celular: o PDF sai sem o croqui.", "erro");
        } catch (e) {
          console.error(e);
          avisar("Não deu para desenhar o croqui: o PDF sai sem ele.", "erro");
        }
      }
      estado.arquivo = tipo === "xlsx"
        ? await M.gerarExcel(o)
        : await M.gerarPdf(o, { comFotos: tipo === "pdf", supervisor, croqui });
    } catch (e) {
      console.error(e);
      avisar(e.message || "Não foi possível gerar o arquivo.", "erro");
    }
    estado.gerando = false;
    render();
  }

  function baixar(blob, nome) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function compartilhar() {
    const a = estado.arquivo;
    try {
      await navigator.share({ files: [arquivoDe(a)], title: a.nome });
    } catch (e) {
      if (e.name !== "AbortError") baixar(a.blob, a.nome);
    }
  }

  function atualizarValoresPonto() {
    const p = ponto();
    p.itens.forEach((i) => {
      const el = document.getElementById(`valor-${i.sid}`);
      if (el) el.textContent = M.fmtMoeda(M.valorItem(i));
    });
    document.getElementById("total-ponto").textContent = M.fmtMoeda(M.totaisPonto(p).valor);
    // subtotais das seções
    document.querySelectorAll(".secao").forEach((h, k) => {
      const ops = M.OPERACOES.filter((op) => p.itens.some((i) => i.operacao === op));
      const itens = p.itens.filter((i) => i.operacao === ops[k]);
      h.lastElementChild.textContent = M.fmtMoeda(M.soma(itens, M.valorItem));
    });
  }

  function atualizarFolha() {
    const qtdOk = M.numero(estado.qtd) > 0;
    const p = ponto();
    const ano = Number((p.dia || hoje()).slice(0, 4));
    document.querySelectorAll("[data-valor-op]").forEach((el) => {
      const s = M.POR_ID.get(Number(el.dataset.valorOp));
      el.textContent = qtdOk ? M.fmtMoeda(M.valorItem({ quantidade: estado.qtd, us: s.us, valor_us: M.valorUS(s.departamento, ano) })) : "";
      const ja = p.itens.some((i) => i.sid === s.id);
      el.parentElement.disabled = ja || !qtdOk;
    });
    document.querySelectorAll("[data-ambos]").forEach((b) => { b.disabled = !qtdOk; });
    const dica = document.querySelector(".folha-dica");
    if (dica) dica.hidden = qtdOk;
  }

  // cliques
  $app.addEventListener("click", async (e) => {
    const passo = e.target.closest("[data-passo]");
    if (passo) {
      const input = passo.closest(".setas").querySelector("input");
      const novo = Math.round((M.numero(input.value || 0) + Number(passo.dataset.passo)) * 10000) / 10000;
      if (novo > 0) {
        input.value = String(novo).replace(".", ",");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    const alvo = e.target.closest("[data-acao]");
    if (!alvo) return;
    if (alvo.tagName === "INPUT") return; // inputs de arquivo usam o change
    if (alvo.dataset.acao === "fechar-folha" && e.target.closest("[data-parar]") && !e.target.closest("button")) return;
    const o = estado.obra;
    switch (alvo.dataset.acao) {
      case "inicio": return irPara("inicio");
      case "config": {
        estado.supervisores = estado.perfil?.admin ? null : [];
        await irPara("config");
        carregarAjustes();
        return mostrarEspaco();
      }
      case "procurar-versao": return procurarVersao(true);
      case "atualizar-app": return atualizarApp();
      case "sair": return sairDaConta();
      case "filtro":
        estado.filtro = alvo.dataset.f;
        return render();
      case "atualizar-lista":
        avisar("Atualizando…", "guardado");
        await enviarPendentes();
        return buscarRemotas(true);
      case "trazer-obra": {
        try {
          avisar("Baixando a obra…", "guardado");
          const obra = await trazerObra(alvo.dataset.id);
          estado.obra = obra;
          $aviso.hidden = true;
          return irPara("obra");
        } catch (err) {
          return avisar(err.message, "erro");
        }
      }
      case "instalar": {
        if (window.pedidoInstalar) {
          window.pedidoInstalar.prompt();
          window.pedidoInstalar = null;
        } else {
          const aj = document.getElementById("ajuda-instalar");
          if (aj) aj.hidden = !aj.hidden;
        }
        return;
      }
      case "nova-obra": return novaObra();
      // ---------- croqui
      case "croqui": {
        // painel do ponto ao lado do croqui: fecha o painel (o ponto fica escolhido)
        if (estado.tela === "croqui" && estado.cqPainel) {
          const id = estado.cqPainel;
          estado.cqPainel = null;
          estado.cqSel = id;
          await salvarAgora();
          return render();
        }
        // vindo de um ponto: o croqui abre com o resumo dele
        const deOnde = estado.tela === "ponto" ? ponto() : null;
        return irPara("croqui", { cqSel: deOnde && !deOnde.geral ? deOnde.id : estado.cqSel, cqRevelar: !!deOnde });
      }
      case "cq-zoom": return visor?.zoom(Number(alvo.dataset.f));
      case "cq-ajustar": return visor?.ajustar();
      case "cq-pag":
        Object.assign(estado, { cqPag: Number(alvo.dataset.p) || 1, cqSel: null, cqNovo: null });
        return render();
      case "cq-fechar":
        estado.cqSel = null;
        return render();
      case "cq-cancelar":
        estado.cqNovo = null;
        estado.cqMover = null;
        if (estado.cqAjuste) { estado.cqSel = estado.cqAjuste.id; estado.cqAjuste = null; }
        return render();
      case "vao-remarcar": { // da tela do vão: vai ao croqui já no ajuste da linha
        const v = ponto();
        if (!v?.vao || !o.projeto) return;
        const a = pontoPorId(v.vao.de)?.croqui;
        return irPara("croqui", { cqAjuste: { id: v.id, pts: [] }, cqSel: null, cqNovo: null, cqCentrar: v.id, cqPag: a?.pag || estado.cqPag });
      }
      case "cq-ajustar-vao": // dois toques: no poste de início e no de fim
        estado.cqAjuste = { id: alvo.dataset.id, pts: [] };
        Object.assign(estado, { cqSel: null, cqNovo: null, cqNota: null, cqDesenho: false });
        return render();
      case "cq-criar": {
        const n = estado.cqNovo;
        if (!n) return;
        const nome = (document.getElementById("cq-nome")?.value || "").trim().toUpperCase().slice(0, 30) || proximoNome(o);
        if (M.pontosReais(o.pontos).some((p) => p.nome === nome) && !confirm(`Já existe o ponto ${nome} nesta obra. Criar outro com o mesmo nome?`)) return;
        estado.cqNovo = null;
        return novoPonto({ nome, croqui: { pag: n.pag, x: n.x, y: n.y } });
      }
      case "cq-usar": {
        const p = pontoPorId(alvo.dataset.id), n = estado.cqNovo;
        if (!p || !n) return;
        p.croqui = { pag: n.pag, x: n.x, y: n.y };
        Object.assign(estado, { cqNovo: null, cqSel: p.id });
        salvarAgora();
        avisar(`${p.nome} marcado no croqui.`);
        return render();
      }
      case "cq-ver": // o nome lido no projeto já é de um ponto marcado: abre ele
        Object.assign(estado, { cqNovo: null, cqSel: alvo.dataset.id, cqCentrar: alvo.dataset.id, cqRevelar: true });
        return render();
      case "cq-mover":
        Object.assign(estado, { cqMover: alvo.dataset.id, cqSel: null, cqNovo: null });
        return render();
      case "cq-foto": {
        // abre o ponto já com a foto no visor
        const p = o.pontos.find((x) => x.fotos.includes(alvo.dataset.id));
        if (!p) return;
        await irPara("ponto", { pontoId: p.id });
        estado.foto = { id: alvo.dataset.id };
        return render();
      }
      case "ver-no-croqui": {
        const p = ponto();
        return irPara("croqui", { cqSel: p.id, cqCentrar: p.id, cqPag: p.croqui?.pag || 1 });
      }
      case "marcar-no-croqui": {
        const p = ponto();
        return irPara("croqui", { cqMover: p.id, cqSel: null, cqPag: p.croqui?.pag || estado.cqPag });
      }
      case "abrir-obra": {
        // obra que ainda não está no celular: traz do banco e abre, sem pedir nada
        let obra = await Banco.obterObra(alvo.dataset.id);
        if (!obra) {
          if (!navigator.onLine) return avisar("Sem internet: essa obra ainda não está neste celular.", "erro");
          try {
            avisar("Abrindo a obra…", "guardado");
            obra = await trazerObra(alvo.dataset.id);
            $aviso.hidden = true;
          } catch (err) {
            return avisar(err.message, "erro");
          }
        }
        estado.obra = obra;
        estado.filtroPonto = ""; // obra nova, pesquisa limpa
        // com o projeto anexado, a obra abre no croqui
        return irPara(obra.projeto ? "croqui" : "obra", { cqSel: null, cqPag: 1 });
      }
      case "editar-obra": return irPara("obra-form");
      case "salvar-obra": return salvarObraForm();
      case "obra": return irPara("obra");
      case "novo-ponto": return novoPonto();
      case "abrir-ponto": return abrirPonto(alvo.dataset.id);
      case "abrir-geral": {
        // serviços da obra sem ponto: guardado como um ponto marcado com `geral`, criado no primeiro toque
        let g = o.pontos.find((p) => p.geral);
        if (!g) {
          g = { id: novoId(), nome: "SERVIÇOS GERAIS", geral: true, dia: hoje(), obs: "", gps: null, itens: [], fotos: [] };
          o.pontos.push(g);
        }
        return irPara("ponto", { pontoId: g.id });
      }
      case "ponto-ant":
      case "ponto-prox": {
        const lista = M.pontosReais(o.pontos);
        const idx = lista.findIndex((p) => p.id === estado.pontoId) + (alvo.dataset.acao === "ponto-ant" ? -1 : 1);
        if (lista[idx]) return abrirPonto(lista[idx].id);
        return;
      }
      case "cq-excluir": { // do resumo do ponto no croqui, sem abrir o ponto
        const p = pontoPorId(alvo.dataset.id);
        if (!p || soLeitura(o)) return;
        if (!confirm(`Excluir o ponto ${p.nome}? Os serviços dele saem da medição.${p.fotos.length ? ` As ${plural(p.fotos.length, "foto", "fotos")} continuam guardadas no celular e no banco.` : ""}`)) return;
        o.pontos = o.pontos.filter((x) => x.id !== p.id);
        estado.cqSel = null;
        salvarAgora();
        avisar(`Ponto ${p.nome} excluído.`);
        return render();
      }
      case "excluir-ponto": {
        const p = ponto();
        if (!confirm(`${p.geral ? "Excluir os serviços lançados sem ponto? Eles saem" : `Excluir o ponto ${p.nome}? Os serviços dele saem`} da medição.${p.fotos.length ? ` As ${plural(p.fotos.length, "foto", "fotos")} continuam guardadas no celular e no banco.` : ""}`)) return;
        o.pontos = o.pontos.filter((x) => x.id !== p.id);
        if (estado.cqSel === p.id) estado.cqSel = null;
        return irPara(o.projeto ? "croqui" : "obra");
      }
      case "excluir-obra": {
        if (soLeitura(o)) {
          // consulta: tira só deste aparelho, a obra continua no banco
          await Banco.excluirObra(o.id);
          estado.obra = null;
          return irPara("inicio");
        }
        if (!(await excluirObra(o.id, o.numero, o.pontos.length))) return;
        estado.obra = null;
        return irPara("inicio");
      }
      case "excluir-obra-lista": { // botão 🗑 do cartão na lista de obras
        const item = obrasDaLista().find((x) => x.id === alvo.dataset.id);
        if (!item?.meu) return;
        if (await excluirObra(item.id, item.numero, item.pontos || 0)) render();
        return;
      }
      case "gps": return marcarGps();
      case "escolher": {
        const g = grupos().find((x) => x.chave === alvo.dataset.chave);
        estado.escolhido = g;
        estado.qtd = "";
        estado.busca = "";
        return render();
      }
      case "sugestao": { // serviço que o projeto pede: abre com a quantidade e o tipo do projeto
        const g = grupos().find((x) => x.chave === alvo.dataset.chave);
        if (!g) return;
        estado.escolhido = { ...g, opSugerida: alvo.dataset.op };
        estado.qtd = alvo.dataset.qtd || "";
        return render();
      }
      case "analisar-projeto": // análise geral de novo (obra com projeto anexado antes)
        irPara("croqui");
        setTimeout(() => pedirAnalise(estado.obra), 300);
        return;
      case "sug-ocultar": // sugestão do projeto que o supervisor não vai usar
      case "sug-mostrar": {
        const p = ponto();
        if (!p) return;
        p.sugOcultas = alvo.dataset.acao === "sug-mostrar" ? [] : [...new Set([...(p.sugOcultas || []), alvo.dataset.chave])];
        salvarAgora();
        // só troca o cartão: refazer a tela tiraria o lugar da rolagem
        const el = document.getElementById("do-projeto");
        if (el) el.outerHTML = doProjetoHtml(o, p);
        return;
      }
      case "vao-servico": { // serviço do vão: abre a quantidade com a metragem ou os espaçadores
        const g = grupos().find((x) => x.chave === alvo.dataset.chave);
        if (!g) return avisar("Esse código não está no catálogo baixado.", "erro");
        estado.escolhido = { ...g, rotulo: alvo.dataset.rotulo };
        estado.qtd = alvo.dataset.qtd || "";
        return render();
      }
      case "cq-vao": { // abre (ou cria) o vão entre os dois postes tocados
        const n = estado.cqNovo;
        if (!n?.vao) return;
        let v = vaoEntre(o, n.vao.de, n.vao.para);
        if (!v) {
          const a = pontoPorId(n.vao.de), b = pontoPorId(n.vao.para);
          if (!a?.croqui || !b?.croqui) return;
          v = {
            id: novoId(), nome: `Vão ${a.nome}–${b.nome}`, vao: { de: a.id, para: b.id, metros: "", espacadores: "" },
            croqui: { pag: n.pag, x: arred((a.croqui.x + b.croqui.x) / 2), y: arred((a.croqui.y + b.croqui.y) / 2) },
            dia: "", obs: "", gps: null, itens: [], fotos: [],
          };
          o.pontos.push(v);
          salvarAgora();
          acharLinhaDoVao(v); // de quadradinho a quadradinho, por cima da rede
        }
        estado.cqNovo = null;
        return abrirPonto(v.id);
      }
      case "cq-anotar": {
        const n = estado.cqNovo;
        if (!n) return;
        estado.cqNota = { id: null, pag: n.pag, x: n.x, y: n.y, texto: "" };
        estado.cqNovo = null;
        render();
        document.getElementById("cq-nota-texto")?.focus();
        return;
      }
      case "nota-rapida": { // anotação pronta: entra no texto (somando, se já tem algo escrito)
        const n = estado.cqNota;
        const campo = document.getElementById("cq-nota-texto");
        if (!n || !campo) return;
        const atual = campo.value.trim();
        campo.value = atual ? `${atual}; ${alvo.dataset.texto}` : alvo.dataset.texto;
        n.texto = campo.value;
        return;
      }
      case "cq-nota-fechar":
        estado.cqNota = null;
        return render();
      case "cq-nota-salvar": {
        const n = estado.cqNota;
        const texto = (n?.texto || "").trim();
        if (!texto) return avisar("Escreva a anotação.", "erro");
        const an = anotacoes(o);
        const ja = n.id && an.notas.find((x) => x.id === n.id);
        if (ja) ja.texto = texto;
        else an.notas.push({ id: novoId(), pag: n.pag, x: n.x, y: n.y, texto, em: new Date().toISOString() });
        estado.cqNota = null;
        salvarAgora();
        avisar("Anotação salva.");
        return render();
      }
      case "cq-nota-excluir": {
        const n = estado.cqNota;
        if (!n?.id || !confirm("Excluir esta anotação do croqui?")) return;
        anotacoes(o).notas = anotacoes(o).notas.filter((x) => x.id !== n.id);
        estado.cqNota = null;
        salvarAgora();
        return render();
      }
      case "cq-rascunho": // liga e desliga o lápis
        estado.cqDesenho = !estado.cqDesenho;
        estado.cqNovo = null;
        estado.cqSel = null;
        estado.cqNota = null;
        if (estado.cqDesenho) avisar("Rascunho ligado: desenhe com um dedo. Dois dedos movem o croqui.", "guardado");
        return render();
      case "cq-desfazer": { // tira o último traço desta folha
        const tr = anotacoes(o).tracos;
        for (let i = tr.length - 1; i >= 0; i--) {
          if (tr[i].pag === estado.cqPag) { tr.splice(i, 1); salvarAgora(); atualizarMarcas(); return; }
        }
        return avisar("Nada para desfazer nesta folha.", "guardado");
      }
      case "cq-baixar": return baixarCroqui();
      case "analise-ok": // fecha o aviso de pontos definidos
        estado.analise = null;
        document.getElementById("cq-analise")?.remove();
        mostrarAnalise();
        return;
      case "cq-girar": { // 90° no sentido do relógio, só esta folha (fica guardado na obra)
        if (!o?.projeto) return;
        const pag = estado.cqPag, g = (giroDa(o, pag) + 90) % 360;
        const giros = { ...(o.projeto.giros || {}) };
        if (g) giros[pag] = g; else delete giros[pag];
        o.projeto.giros = giros;
        if (!soLeitura(o)) salvarAgora();
        return render();
      }
      case "dep-rapidos": // lista pré-definida da LM ou da LV
        depRapidos = alvo.dataset.dep === "LV" ? "LV" : "LM";
        try { localStorage.setItem("croqui_rapidos", depRapidos); } catch (e) { /* sem guardar */ }
        return render();
      case "rapido": {
        const g = grupos().find((x) => x.chave === alvo.dataset.chave);
        if (!g) return avisar("Esse código não está no catálogo baixado.", "erro");
        estado.escolhido = { ...g, rotulo: alvo.dataset.rotulo };
        estado.qtd = "";
        return render();
      }
      case "abrir-busca":
        estado.buscaAberta = !estado.buscaAberta;
        estado.busca = "";
        render();
        if (estado.buscaAberta) document.getElementById("p-busca")?.focus();
        return;
      case "mostrar-banco":
        estado.bancoAberto = !estado.bancoAberto;
        if (estado.bancoAberto && estado.remotas === null) buscarRemotas();
        return render();
      case "fechar-folha":
        estado.escolhido = null;
        return render();
      case "adicionar": return adicionarItem(Number(alvo.dataset.sid));
      case "adicionar-ambos": return adicionarItens(alvo.dataset.sids.split(",").map(Number));
      case "remover-item": {
        const p = ponto();
        p.itens = p.itens.filter((i) => i.sid !== Number(alvo.dataset.sid));
        salvarAgora();
        return render();
      }
      case "camera": return abrirCamera();
      case "cq-camera": // só as fotos do ponto escolhido no croqui (sem abrir a tela do ponto)
        estado.pontoId = alvo.dataset.id;
        return abrirCamera();
      case "ver-foto":
        estado.foto = { id: alvo.dataset.id };
        return render();
      case "fechar-foto":
        estado.foto = null;
        return render();
      case "ordem-pontos":
        estado.ordemPontos = alvo.dataset.ordem === "decr" ? "decr" : "cresc";
        try { localStorage.setItem("croqui_ordem_pontos", estado.ordemPontos); } catch (e) { /* sem memória */ }
        return render();
      case "foto-ant": return andarFoto(-1);
      case "foto-prox": return andarFoto(1);
      case "foto-galeria": {
        const f = await fotoLocal(o, estado.foto.id);
        if (!f) return avisar("A foto ainda não está neste celular.", "erro");
        const p = ponto();
        if (await guardarNoCelular([{ blob: f.blob, nome: nomeFoto(o, p, f.criada_em) }])) {
          f.na_galeria = true;
          await Banco.salvarFoto(f);
          avisar(ehIos() ? "Escolha Salvar imagem para guardar na galeria." : "Foto salva no celular (pasta Download).");
        }
        return;
      }
      case "fotos-galeria": {
        const p = ponto();
        const lista = [];
        for (const [k, id] of p.fotos.entries()) {
          const f = await fotoLocal(o, id);
          if (f) lista.push({ f, blob: f.blob, nome: nomeFoto(o, p, f.criada_em, k + 1) });
        }
        if (!lista.length) return avisar("Nenhuma foto deste ponto está no celular.", "erro");
        if (await guardarNoCelular(lista)) {
          for (const x of lista) { x.f.na_galeria = true; await Banco.salvarFoto(x.f); }
          avisar(ehIos() ? "Escolha Salvar imagens para guardar na galeria." : `${lista.length} ${lista.length === 1 ? "foto salva" : "fotos salvas"} no celular (pasta Download).`);
        }
        return;
      }

      case "excluir-foto": {
        if (soLeitura(o) || !confirm("Tirar esta foto do ponto? Ela sai da medição, mas continua guardada no celular e no banco.")) return;
        const p = ponto();
        p.fotos = p.fotos.filter((id) => id !== estado.foto.id);
        estado.foto = null;
        await salvarAgora();
        return render();
      }
      case "medicao": return irPara("medicao");
      case "gerar-pdf": return gerar("pdf");
      case "gerar-pdf-sem": return gerar("pdf-sem");
      case "gerar-xlsx": return gerar("xlsx");
      case "compartilhar": return compartilhar();
      case "baixar": return baixar(estado.arquivo.blob, estado.arquivo.nome);
      default:
    }
  });

  // digitação
  $app.addEventListener("input", (e) => {
    const t = e.target;
    const p = ponto();
    if (t.id === "f-numero") {
      t.value = t.value.replace(/\D/g, "").slice(0, 10);
      t.className = !t.value ? "" : obraValida(t.value) ? "valido" : "invalido";
      document.getElementById("dica-numero").textContent =
        t.value && !obraValida(t.value) ? `Tem ${t.value.length} dígitos. Precisa de 8 ou 10.` : "";
      return;
    }
    if (t.id === "filtro-itens") {
      estado.filtroItens = t.value;
      const foco = t.selectionStart;
      render();
      const novo = document.getElementById("filtro-itens");
      novo.focus();
      novo.setSelectionRange(foco, foco);
      return;
    }
    if (t.id === "filtro-ponto") {
      estado.filtroPonto = t.value;
      const foco = t.selectionStart;
      render();
      const novo = document.getElementById("filtro-ponto");
      novo.focus();
      novo.setSelectionRange(foco, foco);
      return;
    }
    if (t.id === "filtro-obra") {
      estado.filtroObra = t.value;
      const foco = t.selectionStart;
      render();
      const novo = document.getElementById("filtro-obra");
      novo.focus();
      novo.setSelectionRange(foco, foco);
      return;
    }
    if (t.id === "p-busca") {
      estado.busca = t.value;
      document.getElementById("resultados").innerHTML = resultadosHtml();
      return;
    }
    if (t.id === "qtd-folha") {
      t.value = t.value.replace(/[^\d.,]/g, "");
      estado.qtd = t.value;
      return atualizarFolha();
    }
    if (t.dataset.qtdItem && p) {
      t.value = t.value.replace(/[^\d.,]/g, "");
      const item = p.itens.find((i) => i.sid === Number(t.dataset.qtdItem));
      item.quantidade = t.value;
      salvarDepois();
      return atualizarValoresPonto();
    }
    if (t.id === "cq-nome" && estado.cqNovo) { Object.assign(estado.cqNovo, { nome: t.value.toUpperCase().slice(0, 30), editado: true }); return; }
    if (p && t.id === "p-nome") { p.nome = t.value.toUpperCase().slice(0, 30); salvarDepois(); return; }
    if (p && t.id === "p-obs") { p.obs = t.value; salvarDepois(); return; }
    if (p?.vao && t.id === "p-metros") {
      p.vao.metros = t.value.replace(/[^\d,.]/g, "").slice(0, 8);
      salvarDepois();
      atualizarBotoesVao(p);
      return;
    }
    if (p?.vao && (t.id === "p-vao-de" || t.id === "p-vao-para")) return; // vale no "change"
    if (t.id === "cq-nota-texto" && estado.cqNota) { estado.cqNota.texto = t.value; return; }
  });

  $app.addEventListener("change", (e) => {
    const t = e.target;
    const p = ponto();
    if (p?.vao && (t.id === "p-vao-de" || t.id === "p-vao-para")) return trocarPostesDoVao(p, t);
    if (t.dataset.acao === "projeto") {
      const arquivos = [...t.files];
      t.value = "";
      return receberProjeto(arquivos, t.dataset.modo || "trocar");
    }
    if (t.dataset.acao === "foto") {
      const arquivos = [...t.files];
      t.value = "";
      // do resumo do ponto no croqui: as fotos vão para o ponto escolhido, sem abrir a tela dele
      if (t.dataset.ponto) estado.pontoId = t.dataset.ponto;
      return receberFotos(arquivos, t.dataset.origem || "galeria");
    }
    if (t.dataset.acao === "copia-fotos") {
      try { localStorage.setItem("croqui_copia_fotos", t.checked ? "sim" : "nao"); } catch (err) { /* sem espaço */ }
      return avisar(t.checked ? "Cada foto tirada vai ganhar uma cópia no celular." : "Cópia no celular desligada.");
    }
    if (p && t.id === "p-dia") {
      if (!t.value || t.value > hoje()) { t.value = p.dia; return avisar("A data não pode ser futura.", "erro"); }
      p.dia = t.value;
      salvarAgora();
      return;
    }
    // quantidade mudada na lista: atualiza os números verde/vermelho dos botões
    if (p && t.dataset.qtdItem) return render();
    if (p && t.id === "p-nome") {
      if (!p.nome.trim()) p.nome = proximoNome(estado.obra);
      salvarAgora();
      render();
      refazerFaixas(estado.obra, [p]);
    }
  });

  $app.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "cq-nome") {
      e.preventDefault();
      return document.querySelector('[data-acao="cq-criar"]')?.click();
    }
    if (e.key === "Enter" && e.target.id === "qtd-folha") {
      e.preventDefault();
      const unico = estado.escolhido?.opcoes.filter((s) => !ponto().itens.some((i) => i.sid === s.id));
      if (unico && unico.length === 1) adicionarItem(unico[0].id);
    }
  });

  // o campo de busca sobe para o topo: abaixo dele o teclado cobriria a lista
  $app.addEventListener("focusin", (e) => {
    if (e.target.id === "p-busca") setTimeout(() => e.target.scrollIntoView({ block: "start", behavior: "smooth" }), 300);
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    window.pedidoInstalar = e;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") salvarAgora();
    else {
      enviarDepois(500);
      conferirCatalogo();
    }
  });
  window.addEventListener("online", () => {
    estado.online = true;
    enviarDepois(500);
    buscarRemotas();
    conferirCatalogo(true);
    if (estado.tela === "inicio") render();
  });
  window.addEventListener("offline", () => {
    estado.online = false;
    if (estado.tela === "inicio") render();
  });
  setInterval(() => enviarDepois(0), 20000);
  // o que mudou em outro aparelho chega em qualquer tela (antes só ao voltar para o início)
  setInterval(() => {
    if (document.visibilityState === "visible" && navigator.onLine && !estado.enviando) buscarRemotas();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine && Date.now() - (estado.remotasEm || 0) > 10000) buscarRemotas();
  });
  // fechando ou trocando de app: tenta mandar o que falta (o que não for, continua guardado)
  window.addEventListener("pagehide", () => enviarPendentes());

  // ajustes do administrador: nome, ativo e administrador de cada supervisor
  $app.addEventListener("change", async (e) => {
    const t = e.target;
    const id = t.dataset.supNome || t.dataset.supAtivo || t.dataset.supAdmin;
    if (!id) return;
    const campos = t.dataset.supNome ? { nome: t.value.trim().toUpperCase() } : t.dataset.supAtivo ? { ativo: t.checked } : { admin: t.checked };
    if (campos.nome === "") return avisar("O nome não pode ficar vazio.", "erro");
    try {
      await Nuvem.alterarSupervisor(id, campos);
      if (t.dataset.supNome) t.value = campos.nome;
      avisar("Supervisor atualizado.");
    } catch (err) {
      avisar(err.message, "erro");
    }
  });

  // ------------------------------------------------------------------ entrada
  $app.addEventListener("submit", async (e) => {
    if (e.target.id !== "form-entrar") return;
    e.preventDefault();
    const bt = document.getElementById("bt-entrar");
    const erro = document.getElementById("erro-entrar");
    bt.disabled = true;
    bt.textContent = "Entrando…";
    erro.hidden = true;
    try {
      const perfil = await Nuvem.entrar(document.getElementById("e-email").value.trim(), document.getElementById("e-senha").value);
      estado.perfil = perfil;
      await Banco.gravar("perfil", perfil);
      await baixarCatalogo();
      Banco.pedirPersistencia();
      await iniciar();
    } catch (err) {
      erro.textContent = err.status === 0 ? "Sem conexão. Para entrar é preciso de internet." : err.message;
      erro.hidden = false;
      bt.disabled = false;
      bt.textContent = "Entrar";
    }
  });

  async function baixarCatalogo() {
    const cat = await Nuvem.catalogo();
    if (!cat.servicos.length) throw new Error("O catálogo do banco está vazio.");
    await Banco.gravar("catalogo", cat);
    M.usarCatalogo(cat);
    cacheGrupos.clear();
    codigosEstrutura = null;
  }

  /** Catálogo sempre igual ao do banco, sem botão: confere ao abrir o app, quando o
   *  sinal volta, ao voltar para o app e a cada 15 min. O que já foi lançado guarda o
   *  valor da época (regra do Termômetro); o novo vale para os próximos lançamentos. */
  let catalogoConferidoEm = 0;
  async function conferirCatalogo(forcar = false) {
    if (!navigator.onLine) return;
    if (!forcar && Date.now() - catalogoConferidoEm < 5 * 60000) return;
    catalogoConferidoEm = Date.now();
    procurarVersao();
    if (!Nuvem.lerSessao() || !estado.perfil) return;
    try {
      const novo = await Nuvem.catalogo();
      if (!novo.servicos.length) return;
      const atual = await Banco.ler("catalogo");
      const chave = (c) => (c ? JSON.stringify([c.valor_us, c.servicos]) : "");
      if (chave(novo) === chave(atual)) return;
      await Banco.gravar("catalogo", novo);
      M.usarCatalogo(novo);
      cacheGrupos.clear();
      codigosEstrutura = null;
      // refaz a tela só se ninguém estiver digitando ou com a janela de quantidade aberta
      if (!estado.escolhido && !document.activeElement?.matches?.("input, textarea")) render();
    } catch (e) { /* tenta na próxima */ }
  }
  setInterval(() => conferirCatalogo(true), 15 * 60000);

  // ------------------------------------------------------------------ versão do app
  /* versao.js diz o número; o app pergunta ao servidor se saiu outro (ao abrir, ao
     voltar o sinal, ao voltar para o app e a cada 15 min) e mostra em Ajustes. */
  const versaoAtual = () => window.VERSAO_APP || { numero: "?", data: "" };
  async function procurarVersao(manual = false) {
    if (!navigator.onLine) { if (manual) avisar("Sem internet para procurar atualização.", "erro"); return; }
    if (manual) { estado.procurandoVersao = true; if (estado.tela === "config") render(); }
    try {
      const txt = await (await fetch("versao.js", { cache: "no-store" })).text();
      const numero = Number((txt.match(/numero:\s*(\d+)/) || [])[1]);
      const data = (txt.match(/data:\s*"([^"]*)"/) || [])[1] || "";
      const antes = estado.novaVersao?.numero;
      estado.novaVersao = numero > Number(versaoAtual().numero) ? { numero, data } : null;
      if (manual && !estado.novaVersao) avisar("Você já está na versão mais nova.");
      if (manual || antes !== estado.novaVersao?.numero) {
        if ((estado.tela === "config" || estado.tela === "inicio") && !estado.escolhido && !document.activeElement?.matches?.("input, textarea")) render();
      }
    } catch (e) {
      if (manual) avisar("Não deu para procurar agora. Tente de novo.", "erro");
    } finally {
      if (manual) { estado.procurandoVersao = false; if (estado.tela === "config") render(); }
    }
  }
  async function atualizarApp() {
    avisar("Atualizando o app…", "guardado");
    await salvarAgora();
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        // a versão nova se instala e assume; o "controllerchange" recarrega a página
        const assumiu = new Promise((ok) => navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true }));
        await reg.update();
        await Promise.race([assumiu, new Promise((ok) => setTimeout(ok, 8000))]);
      }
    } catch (e) { /* recarrega assim mesmo */ }
    location.reload();
  }

  async function sairDaConta(forcado = false) {
    if (!forcado) {
      await salvarAgora();
      await enviarPendentes();
      const pend = (await Banco.listarObras()).filter((o) => o.pendente && !soLeitura(o)).length;
      if (pend) {
        alert(`${plural(pend, "obra ainda não subiu", "obras ainda não subiram")} para o banco. Fique com internet até aparecer "Tudo salvo no banco" e saia depois.`);
        return;
      }
    }
    Nuvem.sair();
    estado.perfil = null;
    estado.remotas = null;
    estado.obra = null;
    await Banco.gravar("perfil", null);
    estado.tela = "entrar";
    render();
  }

  async function carregarAjustes() {
    if (!estado.perfil?.admin || !navigator.onLine) return;
    try {
      estado.supervisores = await Nuvem.supervisores();
    } catch (e) {
      estado.supervisores = [];
    }
    if (estado.tela === "config") render();
  }

  /** Abre o app: com sessão e catálogo guardados entra direto, mesmo sem sinal. */
  async function iniciar() {
    if (!Nuvem.lerSessao()) {
      estado.tela = "entrar";
      return render();
    }
    estado.perfil = await Banco.ler("perfil");
    const cat = await Banco.ler("catalogo");
    if (cat) M.usarCatalogo(cat);
    if (!cat || !estado.perfil) {
      estado.tela = "carregando";
      estado.carregandoTexto = "Baixando o catálogo de serviços…";
      render();
      try {
        if (!estado.perfil) {
          estado.perfil = await Nuvem.meuPerfil();
          await Banco.gravar("perfil", estado.perfil);
        }
        if (!cat) await baixarCatalogo();
      } catch (e) {
        estado.carregandoTexto = e.status === 0 ? "Sem internet. Na primeira vez é preciso de sinal para baixar o catálogo." : e.message;
        render();
        if (e.status === 401 || e.status === 403) return sairDaConta(true);
        return;
      }
    }
    await irPara("inicio");
    setTimeout(() => subirLeiturasLocais().catch((e) => console.warn("subir leituras:", e)), 1000);
    setTimeout(() => retomarAnalise().catch((e) => console.warn("retomar análise:", e)), 1500);
    // guarda permanente (o navegador não apaga nada sozinho) e aviso de espaço apertado
    Banco.pedirPersistencia();
    conferirEspaco().then(() => estado.espacoApertado && estado.tela === "inicio" && render());
    if (navigator.onLine) {
      // confere se o acesso continua ativo e se o nome mudou
      Nuvem.meuPerfil().then(async (p) => {
        if (!p || !p.ativo) { avisar("Seu acesso foi desativado.", "erro"); return sairDaConta(true); }
        estado.perfil = p;
        await Banco.gravar("perfil", p);
        if (estado.tela === "inicio") render();
      }).catch(() => {});
      await enviarPendentes();
      buscarRemotas();
      conferirCatalogo(true);
    }
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    // pergunta por versão nova a cada abertura e recarrega uma vez quando ela assume
    let jaRecarregou = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (jaRecarregou) return;
      jaRecarregou = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
  }

  iniciar();
})();

