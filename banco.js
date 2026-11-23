/* Banco do aparelho (IndexedDB). O celular trabalha sempre aqui, com ou sem sinal;
   o envio para o Supabase (nuvem.js) lê daqui. Lojas: "obras" (pontos e serviços),
   "fotos" (arquivos), "projetos" (o PDF ou a imagem do projeto de cada obra, o croqui)
   "chaves" (catálogo guardado, sessão do supervisor...) e "copias" (cópias de segurança de
   cada obra, guardadas sozinhas enquanto o supervisor trabalha: se der algum erro, dá para
   voltar a obra como estava). */
(function () {
  const NOME = "medicao-croqui";
  let conexao = null;

  function abrir() {
    if (conexao) return conexao;
    conexao = new Promise((ok, falha) => {
      const req = indexedDB.open(NOME, 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("obras")) db.createObjectStore("obras", { keyPath: "id" });
        if (!db.objectStoreNames.contains("fotos")) {
          const f = db.createObjectStore("fotos", { keyPath: "id" });
          f.createIndex("obra", "obraId");
        }
        if (!db.objectStoreNames.contains("chaves")) db.createObjectStore("chaves", { keyPath: "k" });
        if (!db.objectStoreNames.contains("projetos")) db.createObjectStore("projetos", { keyPath: "obraId" });
        if (!db.objectStoreNames.contains("copias")) {
          const c = db.createObjectStore("copias", { keyPath: "id" });
          c.createIndex("obra", "obraId");
        }
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => falha(req.error);
    });
    return conexao;
  }

  async function operar(loja, modo, fn) {
    const db = await abrir();
    return new Promise((ok, falha) => {
      const tx = db.transaction(loja, modo);
      const st = tx.objectStore(loja);
      let resultado;
      const r = fn(st);
      if (r) r.onsuccess = () => (resultado = r.result);
      tx.oncomplete = () => ok(resultado);
      tx.onerror = () => falha(tx.error);
      tx.onabort = () => falha(tx.error || new Error("Operação cancelada"));
    });
  }

  // ---------------------------------------------------------------- cópias de segurança
  /* Cada obra guarda sozinha cópias do que foi lançado (pontos, serviços, vãos, anotações;
     as fotos ficam na loja "fotos", que nunca apaga foto). Uma cópia a cada 10 minutos de
     trabalho: dentro dos 10 minutos a última cópia vai sendo atualizada; se a obra PERDE
     pontos com coisa lançada, a cópia anterior fica guardada e começa outra. Ficam as 40 mais
     novas de cada obra e, sempre, a que tem mais coisa lançada. Obra excluída mantém as cópias. */
  const COPIA_INTERVALO = 10 * 60 * 1000;
  const COPIAS_POR_OBRA = 40;
  const temCoisa = (p) => !!((p.itens && p.itens.length) || (p.fotos && p.fotos.length) || String(p.obs || "").trim());
  /** o que a cópia guarda: a obra sem o que é só do envio ou se refaz sozinho */
  function conteudo(obra) {
    const c = JSON.parse(JSON.stringify(obra));
    for (const k of ["base_pontos", "rotulos", "pendente", "erro_envio"]) delete c[k];
    return c;
  }
  function resumo(o) {
    const pontos = o.pontos || [];
    const postes = pontos.filter((p) => !p.vao && !p.geral);
    return {
      pontos: postes.length,
      lancados: pontos.filter(temCoisa).length,
      vaos: pontos.filter((p) => p.vao).length,
      servicos: pontos.reduce((t, p) => t + (p.itens?.length || 0), 0),
      fotos: pontos.reduce((t, p) => t + (p.fotos?.length || 0), 0),
      valor: (() => { try { return window.Medicao?.totaisObra(o).valor ?? null; } catch (e) { return null; } })(),
    };
  }
  const assinaturaCopia = (c) => JSON.stringify([c.numero, c.local, c.municipio, c.equipe, c.obs, c.departamento, c.pontos, c.anotacoes, c.folha, c.projeto?.em]);
  const copiasDaObra = (obraId) => operar("copias", "readonly", (s) => s.index("obra").getAll(obraId));
  /** cópias da obra pela chave ("obra|data"): a última sem ler as outras */
  const faixaDa = (obraId) => IDBKeyRange.bound(`${obraId}|`, `${obraId}|￿`);
  async function ultimaCopia(obraId) {
    const db = await abrir();
    return new Promise((ok, falha) => {
      const req = db.transaction("copias", "readonly").objectStore("copias").openCursor(faixaDa(obraId), "prev");
      req.onsuccess = () => ok(req.result ? req.result.value : null);
      req.onerror = () => falha(req.error);
    });
  }
  // a última cópia de cada obra fica na memória: gravar a obra não relê as cópias toda vez
  const ultimas = new Map();
  /** junta numa cópia só o trabalho de 10 minutos (não junta com cópia de restauração ou de arquivo) */
  const JUNTA = new Set(["automática", "do banco"]);
  /** guarda a cópia da obra (motivo: "automática", "do banco", "antes de restaurar", "arquivo"...);
   *  `forcar`: cópia nova mesmo dentro dos 10 minutos */
  async function guardarCopia(obra, motivo = "automática", { forcar = false } = {}) {
    if (!obra?.id || !obra.criada_em || obra.dono === false) return null; // obra de outro: só consulta
    const dados = conteudo(obra);
    const ass = assinaturaCopia(dados);
    if (!ultimas.has(obra.id)) ultimas.set(obra.id, await ultimaCopia(obra.id));
    const ultima = ultimas.get(obra.id);
    if (ultima && ultima.ass === ass && !forcar) return ultima; // nada mudou
    const res = resumo(dados);
    const agora = new Date().toISOString();
    const perdeu = ultima && res.lancados < (ultima.resumo?.lancados || 0);
    const junto = ultima && !forcar && !perdeu && JUNTA.has(ultima.motivo) && JUNTA.has(motivo)
      && Date.now() - new Date(ultima.inicio || ultima.em).getTime() < COPIA_INTERVALO;
    const copia = {
      id: junto ? ultima.id : `${obra.id}|${agora}`, obraId: obra.id, numero: obra.numero, em: agora,
      inicio: junto ? ultima.inicio || ultima.em : agora, motivo, ass, resumo: res, obra: dados,
    };
    await operar("copias", "readwrite", (s) => s.put(copia));
    ultimas.set(obra.id, copia);
    // limpeza (de vez em quando): as 40 mais novas e a com mais coisa lançada
    if (!junto) {
      const qtd = await operar("copias", "readonly", (s) => s.count(faixaDa(obra.id)));
      if (qtd > COPIAS_POR_OBRA + 5) {
        const todas = (await copiasDaObra(obra.id)).sort((a, b) => String(a.em).localeCompare(String(b.em)));
        const maior = todas.reduce((m, c) => (!m || c.resumo.lancados > m.resumo.lancados || (c.resumo.lancados === m.resumo.lancados && c.resumo.servicos > m.resumo.servicos) ? c : m), null);
        const sair = todas.slice(0, todas.length - COPIAS_POR_OBRA).filter((c) => c.id !== maior.id);
        await operar("copias", "readwrite", (s) => { sair.forEach((c) => s.delete(c.id)); });
      }
    }
    return copia;
  }
  /** cópia sem parar o que chamou, uma de cada vez (erro na cópia não atrapalha o trabalho) */
  let filaCopias = Promise.resolve();
  const copiarDepois = (obra, motivo) => {
    const foto = JSON.parse(JSON.stringify(obra));
    filaCopias = filaCopias.then(() => guardarCopia(foto, motivo)).catch((e) => console.warn("cópia de segurança:", e));
    return filaCopias;
  };
  /** guarda na fila (espera as automáticas que estão na frente) */
  const guardarNaFila = (obra, motivo, opcoes) => {
    const r = filaCopias.then(() => guardarCopia(obra, motivo, opcoes));
    filaCopias = r.catch(() => {});
    return r;
  };

  window.Banco = {
    listarObras: () => operar("obras", "readonly", (s) => s.getAll()),
    obterObra: (id) => operar("obras", "readonly", (s) => s.get(id)),
    /** Grava a obra. Mudança feita pelo supervisor marca a obra para envio;
     *  `{ envio: true }` é a gravação do próprio envio, que não muda nada disso. */
    salvarObra: (obra, { envio = false } = {}) => {
      if (!envio) {
        obra.atualizada_em = new Date().toISOString();
        obra.pendente = true;
      }
      return operar("obras", "readwrite", (s) => s.put(obra)).then((r) => {
        copiarDepois(obra, envio ? "do banco" : "automática");
        return r;
      });
    },
    guardarCopia: guardarNaFila,
    /** espera as cópias que ainda estão sendo guardadas */
    copiasProntas: () => filaCopias,
    listarCopias: (obraId) => (obraId ? copiasDaObra(obraId) : operar("copias", "readonly", (s) => s.getAll())),
    obterCopia: (id) => operar("copias", "readonly", (s) => s.get(id)),
    /** cópia vinda de um arquivo de backup (não troca a que já existe com o mesmo id) */
    async importarCopia(c) {
      if (!c?.id || !c.obraId || !c.obra) return false;
      if (await operar("copias", "readonly", (s) => s.get(c.id))) return false;
      await operar("copias", "readwrite", (s) => s.put({ ...c, resumo: c.resumo || resumo(c.obra), ass: c.ass || assinaturaCopia(c.obra) }));
      ultimas.delete(c.obraId);
      return true;
    },
    /** tira a obra; as fotos dela continuam guardadas no aparelho (nunca se perde foto) */
    excluirObra: (id) => operar("obras", "readwrite", (s) => s.delete(id)),
    salvarFoto: (foto) => operar("fotos", "readwrite", (s) => s.put(foto)),
    obterFoto: (id) => operar("fotos", "readonly", (s) => s.get(id)),
    fotosDaObra: (obraId) => operar("fotos", "readonly", (s) => s.index("obra").getAll(obraId)),
    todasFotos: () => operar("fotos", "readonly", (s) => s.getAll()),
    /** projeto da obra: { obraId, blob, nome, tipo, enviado } */
    salvarProjeto: (proj) => operar("projetos", "readwrite", (s) => s.put(proj)),
    obterProjeto: (obraId) => operar("projetos", "readonly", (s) => s.get(obraId)),
    /** o navegador não apaga nada sozinho quando o celular fica sem espaço */
    async persistente() {
      try { return !!(navigator.storage && (await navigator.storage.persisted())); } catch (e) { return false; }
    },
    async ler(k, padrao = null) {
      const r = await operar("chaves", "readonly", (s) => s.get(k));
      return r ? r.v : padrao;
    },
    gravar: (k, v) => operar("chaves", "readwrite", (s) => s.put({ k, v })),
    async pedirPersistencia() {
      try {
        if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
      } catch (e) { /* sem suporte */ }
      return false;
    },
    async espaco() {
      try {
        if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
      } catch (e) { /* sem suporte */ }
      return null;
    },
  };
})();
