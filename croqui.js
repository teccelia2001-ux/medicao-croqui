/* Croqui: mostra o projeto da obra (PDF ou imagem) com zoom e arrasto e marca em cima os
   pontos medidos (P1, P2...). Um toque no desenho avisa o app onde foi (para criar um
   ponto ali); um toque num ponto avisa qual foi (para mostrar o que foi feito nele).

   A posição do ponto é guardada em fração da folha ({ pag, x, y } de 0 a 1): continua
   certa em qualquer tela, zoom ou aparelho.

   Nitidez: a folha inteira é desenhada uma vez numa imagem grande (base) e, quando o
   supervisor aproxima além dela, o pedaço que está na tela é redesenhado na resolução
   exata (detalhe), um instante depois de o dedo parar. */
(function () {
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  const BASE_LADO = 4096; // limite de lado e de área da imagem base (o celular aguenta)
  const BASE_AREA = 7e6;
  const DETALHE_AREA = 7e6;
  const ZOOM_MAX = 18; // vezes a folha inteira na tela

  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function esperarPdfjs() {
    return new Promise((ok, falha) => {
      let n = 0;
      const t = setInterval(() => {
        if (window.pdfjsLib) {
          clearInterval(t);
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
          ok(window.pdfjsLib);
        } else if (++n > 300) {
          clearInterval(t);
          falha(new Error("Não deu para carregar o leitor de PDF. Abra o app uma vez com internet."));
        }
      }, 50);
    });
  }

  // ------------------------------------------------------------------ documento
  // aberto uma vez por arquivo: trocar de tela não lê o PDF de novo
  const abertos = new Map();
  const chaveDe = (proj) => `${proj.obraId}|${proj.em || ""}|${proj.blob.size}`;
  function abrir(proj) {
    const chave = chaveDe(proj);
    if (!abertos.has(chave)) {
      abertos.set(chave, (async () => {
        if (proj.tipo === "application/pdf") {
          const lib = await esperarPdfjs();
          const dados = new Uint8Array(await proj.blob.arrayBuffer());
          const pdf = await lib.getDocument({ data: dados, isEvalSupported: false }).promise;
          return { tipo: "pdf", pdf, paginas: pdf.numPages, chave, folhas: new Map() };
        }
        const img = await abrirImagem(proj.blob);
        return { tipo: "img", img, paginas: 1, chave, folhas: new Map() };
      })().catch((e) => {
        abertos.delete(chave);
        throw e;
      }));
    }
    return abertos.get(chave);
  }
  async function abrirImagem(blob) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (e) { /* pelo <img> */ }
    }
    return new Promise((ok, falha) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => falha(new Error("Não deu para abrir a imagem do projeto."));
      img.src = URL.createObjectURL(blob);
    });
  }

  /** Folha n: tamanho (W x H, em pontos do PDF ou pixels da imagem) e um jeito de desenhar
   *  um pedaço dela: `desenhar(ctx, escala, dx, dy)` põe o ponto (x, y) da folha no pixel
   *  (x*escala - dx, y*escala - dy). Devolve { promise, cancelar }.
   *  `semTela`: para o PDF da medição. O desenho da tela anda no ritmo da tela (pára se o
   *  supervisor troca de app); o do arquivo não depende dela. */
  async function folha(doc, n) {
    if (doc.folhas.has(n)) return doc.folhas.get(n);
    let f;
    if (doc.tipo === "pdf") {
      const page = await doc.pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      f = {
        W: vp.width, H: vp.height,
        desenhar(ctx, escala, dx, dy, semTela = false) {
          ctx.save();
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
          ctx.restore();
          const tarefa = page.render({
            canvasContext: ctx,
            viewport: page.getViewport({ scale: escala }),
            transform: [1, 0, 0, 1, -dx, -dy],
            intent: semTela ? "print" : "display",
          });
          return { promise: tarefa.promise, cancelar: () => tarefa.cancel() };
        },
      };
    } else {
      const img = doc.img;
      f = {
        W: img.width, H: img.height,
        desenhar(ctx, escala, dx, dy) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, -dx, -dy, img.width * escala, img.height * escala);
          return { promise: Promise.resolve(), cancelar() {} };
        },
      };
    }
    doc.folhas.set(n, f);
    return f;
  }

  // ------------------------------------------------------------------ visor
  class Visor {
    constructor() {
      const el = document.createElement("div");
      el.className = "cq-visor";
      el.innerHTML = `<canvas class="cq-base"></canvas><canvas class="cq-detalhe" hidden></canvas>
        <div class="cq-marcas"></div><div class="cq-alfinete" hidden></div>
        <div class="cq-msg" hidden></div>`;
      this.el = el;
      this.base = el.querySelector(".cq-base");
      this.detalhe = el.querySelector(".cq-detalhe");
      this.marcasEl = el.querySelector(".cq-marcas");
      this.alfineteEl = el.querySelector(".cq-alfinete");
      this.msgEl = el.querySelector(".cq-msg");
      this.s = 1; this.tx = 0; this.ty = 0; this.W = 0; this.H = 0;
      this.sb = 1; // escala da imagem base
      this.det = null; // {s, tx, ty} de quando o detalhe foi desenhado
      this.pos = null; // alfinete {x, y}
      this.cw = 0; this.ch = 0;
      this.onVazio = null; // (pos {x, y}) => {}
      this.onMarca = null; // (id) => {}
      this._ligarGestos();
      new ResizeObserver(() => this._redimensionou()).observe(el);
    }

    get paginas() { return this.doc?.paginas || 0; }

    msg(texto) {
      this.msgEl.textContent = texto || "";
      this.msgEl.hidden = !texto;
    }

    /** Abre o projeto na folha pedida. Mesmo projeto e mesma folha: não faz nada. */
    carregar(proj, pag = 1) {
      const chave = chaveDe(proj);
      if (this.chave === chave && this.pag === pag) return Promise.resolve();
      // o mesmo pedido já está em andamento (a tela foi redesenhada no meio): espera ele
      if (this._emCurso && this._emCurso.chave === chave && this._emCurso.pag === pag) return this._emCurso.promise;
      const em = { chave, pag };
      em.promise = this._carregar(proj, pag, chave).finally(() => { if (this._emCurso === em) this._emCurso = null; });
      this._emCurso = em;
      return em.promise;
    }

    async _carregar(proj, pag, chave) {
      const pedido = (this._pedido = {});
      this._tarefaBase?.cancelar();
      if (this.chave !== chave) {
        this.base.hidden = true;
        this.detalhe.hidden = true;
      }
      this.msg("Abrindo o projeto…");
      const doc = await abrir(proj);
      pag = Math.min(Math.max(1, pag), doc.paginas);
      const f = await folha(doc, pag);
      if (pedido !== this._pedido) return; // pediram outro no meio do caminho
      this.doc = doc; this.f = f; this.pag = pag; this.chave = chave;
      this.W = f.W; this.H = f.H;
      this.sb = Math.min(BASE_LADO / Math.max(f.W, f.H), Math.sqrt(BASE_AREA / (f.W * f.H)));
      this.base.width = Math.round(f.W * this.sb);
      this.base.height = Math.round(f.H * this.sb);
      this.base.style.width = this.base.width + "px";
      this.base.style.height = this.base.height + "px";
      this._tarefaDet?.cancelar();
      this.det = null;
      this.detalhe.hidden = true;
      this.msg("Desenhando o projeto…");
      const tarefa = f.desenhar(this.base.getContext("2d"), this.sb, 0, 0);
      this._tarefaBase = tarefa;
      try {
        await tarefa.promise;
      } catch (e) {
        if (pedido !== this._pedido) return; // trocou de folha no meio
        throw e;
      }
      if (pedido !== this._pedido) return;
      this.msg("");
      this.base.hidden = false;
      this._ajustado = false;
      this._mexeu = false;
      this.ajustar();
    }

    /** escala com a folha inteira na tela */
    get sMin() {
      return this.W ? Math.min(this.cw / this.W, this.ch / this.H) : 1;
    }

    ajustar() {
      if (!this.W || !this.cw) return;
      this.s = this._sAjuste = this.sMin * 0.97;
      this.tx = (this.cw - this.W * this.s) / 2;
      this.ty = (this.ch - this.H * this.s) / 2;
      this._ajustado = true;
      this._mexeu = false;
      this._aplicar();
    }

    /** aproxima (fator > 1) ou afasta em volta do ponto da tela (cx, cy) */
    zoom(fator, cx = this.cw / 2, cy = this.ch / 2) {
      this._zoomPara(this.s * fator, cx, cy);
    }
    _zoomPara(novo, cx, cy) {
      const s = Math.min(this.sMin * ZOOM_MAX, Math.max(this.sMin * 0.6, novo));
      const wx = (cx - this.tx) / this.s, wy = (cy - this.ty) / this.s;
      this.tx = cx - wx * s;
      this.ty = cy - wy * s;
      this.s = s;
      this._aplicar();
    }

    /** põe o ponto (fração da folha) no meio da tela, aproximando até `vezes` a folha inteira */
    centralizar(pos, vezes = 4) {
      if (!pos || !this.W) return;
      this.s = Math.max(this.s, this.sMin * vezes);
      this.tx = this.cw / 2 - pos.x * this.W * this.s;
      this.ty = this.ch / 2 - pos.y * this.H * this.s;
      this._mexeu = true;
      this._aplicar();
    }

    /** arrasta só o necessário para o ponto não ficar embaixo do resumo, que cobre
     *  `baixo` px da parte de baixo (celular em pé) ou `direita` px da direita (deitado) */
    revelar(pos, { baixo = 0, direita = 0 } = {}) {
      if (!pos || !this.W) return;
      const x = this.tx + pos.x * this.W * this.s, y = this.ty + pos.y * this.H * this.s;
      const altura = this.ch - baixo, largura = this.cw - direita;
      if (y > altura - 36 || y < 70) this.ty += Math.max(90, altura / 2) - y;
      if (x < 30 || x > largura - 70) this.tx += largura / 2 - x;
      this._mexeu = true;
      this._aplicar();
    }

    /** pontos marcados nesta folha: [{ id, nome, x, y, classe }] */
    marcas(lista) {
      this.marcasEl.innerHTML = lista.map((m) => `<button type="button" class="cq-marca ${m.classe || ""}" data-id="${esc(m.id)}" data-x="${m.x}" data-y="${m.y}" aria-label="${esc(m.nome)}"><i></i><span>${esc(m.nome)}</span></button>`).join("");
      this._posicionarMarcas();
    }

    /** alfinete provisório (onde o supervisor tocou), ou null para tirar */
    alfinete(pos) {
      this.pos = pos;
      this.alfineteEl.hidden = !pos;
      this._posicionarMarcas();
    }

    /** fração da folha embaixo do ponto da tela (cx, cy); null se caiu fora da folha */
    paraFolha(cx, cy) {
      const x = (cx - this.tx) / this.s / this.W, y = (cy - this.ty) / this.s / this.H;
      return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
    }

    // ---------------------------------------------------------------- desenho
    _redimensionou() {
      const cw = this.el.clientWidth, ch = this.el.clientHeight;
      if (!cw || !ch) return; // fora da tela
      if (this.cw && this._ajustado && (cw !== this.cw || ch !== this.ch)) {
        // girou o celular ou mudou a janela: o meio continua no meio
        this.tx += (cw - this.cw) / 2;
        this.ty += (ch - this.ch) / 2;
      }
      const primeira = !this.cw;
      this.cw = cw; this.ch = ch;
      // ainda sem mexer no zoom: continua mostrando a folha inteira no tamanho novo
      if (primeira || !this._ajustado || !this._mexeu) this.ajustar();
      else this._aplicar();
    }

    _limitar() {
      // a folha não some da tela: a borda dela não passa do meio
      const w = this.W * this.s, h = this.H * this.s;
      this.tx = Math.min(this.cw / 2, Math.max(this.cw / 2 - w, this.tx));
      this.ty = Math.min(this.ch / 2, Math.max(this.ch / 2 - h, this.ty));
    }

    _aplicar() {
      if (!this.W) return;
      if (this._ajustado && this._sAjuste !== this.s) this._mexeu = true;
      this._limitar();
      const k = this.s / this.sb;
      this.base.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${k})`;
      if (this.det && !this.detalhe.hidden) {
        const kd = this.s / this.det.s;
        this.detalhe.style.transform = `translate(${this.tx - this.det.tx * kd}px, ${this.ty - this.det.ty * kd}px) scale(${kd})`;
      }
      this._posicionarMarcas();
      clearTimeout(this._tempoDet);
      this._tempoDet = setTimeout(() => this._desenharDetalhe(), 220);
    }

    _posicionarMarcas() {
      if (!this.W) return;
      for (const b of this.marcasEl.children) {
        const x = this.tx + Number(b.dataset.x) * this.W * this.s;
        const y = this.ty + Number(b.dataset.y) * this.H * this.s;
        b.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (this.pos) {
        this.alfineteEl.style.transform = `translate(${this.tx + this.pos.x * this.W * this.s}px, ${this.ty + this.pos.y * this.H * this.s}px)`;
      }
    }

    /** pedaço da tela na resolução exata, quando a imagem base já não dá conta */
    async _desenharDetalhe() {
      if (!this.f || !this.cw) return;
      let dpr = window.devicePixelRatio || 1;
      if (this.s * dpr <= this.sb * 1.1) {
        this.detalhe.hidden = true;
        this.det = null;
        return;
      }
      if (this.det && this.det.s === this.s && this.det.tx === this.tx && this.det.ty === this.ty) return;
      if (this.cw * this.ch * dpr * dpr > DETALHE_AREA) dpr = Math.sqrt(DETALHE_AREA / (this.cw * this.ch));
      this._tarefaDet?.cancelar();
      const vista = { s: this.s, tx: this.tx, ty: this.ty };
      const cv = document.createElement("canvas");
      cv.width = Math.round(this.cw * dpr);
      cv.height = Math.round(this.ch * dpr);
      const tarefa = this.f.desenhar(cv.getContext("2d"), vista.s * dpr, -vista.tx * dpr, -vista.ty * dpr);
      this._tarefaDet = tarefa;
      try {
        await tarefa.promise;
      } catch (e) {
        return; // cancelado: veio outro gesto
      }
      if (this._tarefaDet !== tarefa) return;
      const d = this.detalhe;
      d.width = cv.width;
      d.height = cv.height;
      d.getContext("2d").drawImage(cv, 0, 0);
      d.style.width = this.cw + "px";
      d.style.height = this.ch + "px";
      this.det = vista;
      d.hidden = false;
      const kd = this.s / vista.s;
      d.style.transform = `translate(${this.tx - vista.tx * kd}px, ${this.ty - vista.ty * kd}px) scale(${kd})`;
    }

    // ---------------------------------------------------------------- gestos
    /* Um dedo arrasta; dois dedos aproximam; toque rápido marca; toque duplo aproxima.
       No computador: arrastar com o mouse, rodinha aproxima, clique duplo aproxima. */
    _ligarGestos() {
      const el = this.el;
      const dedos = new Map();
      let gesto = null;
      let toque = null;
      const rel = (p) => {
        const r = el.getBoundingClientRect();
        return { x: p.x - r.left, y: p.y - r.top };
      };
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const meio = (a, b) => rel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const comecarArrasto = (p) => ({ tipo: "arrasto", x0: p.x, y0: p.y, tx0: this.tx, ty0: this.ty });

      el.addEventListener("pointerdown", (e) => {
        if (e.button > 0 || !this.W) return;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* segue */ }
        const p = { x: e.clientX, y: e.clientY };
        dedos.set(e.pointerId, p);
        if (dedos.size === 1) {
          toque = { ...p, t: Date.now(), alvo: e.target.closest(".cq-marca") };
          gesto = comecarArrasto(p);
        } else if (dedos.size === 2) {
          toque = null;
          const [a, b] = [...dedos.values()];
          gesto = { tipo: "pinca", d0: dist(a, b) || 1, m0: meio(a, b), s0: this.s, tx0: this.tx, ty0: this.ty };
        }
      });
      el.addEventListener("pointermove", (e) => {
        if (!dedos.has(e.pointerId)) return;
        const p = { x: e.clientX, y: e.clientY };
        dedos.set(e.pointerId, p);
        if (gesto?.tipo === "arrasto" && dedos.size === 1) {
          if (toque && Math.hypot(p.x - toque.x, p.y - toque.y) > 9) toque = null;
          if (toque) return; // ainda pode ser um toque
          this.tx = gesto.tx0 + p.x - gesto.x0;
          this.ty = gesto.ty0 + p.y - gesto.y0;
          this._mexeu = true;
          this._aplicar();
        } else if (gesto?.tipo === "pinca" && dedos.size === 2) {
          const [a, b] = [...dedos.values()];
          const m = meio(a, b);
          const s = Math.min(this.sMin * ZOOM_MAX, Math.max(this.sMin * 0.6, gesto.s0 * (dist(a, b) / gesto.d0)));
          // o ponto da folha que estava entre os dedos acompanha os dedos
          const wx = (gesto.m0.x - gesto.tx0) / gesto.s0, wy = (gesto.m0.y - gesto.ty0) / gesto.s0;
          this.s = s;
          this.tx = m.x - wx * s;
          this.ty = m.y - wy * s;
          this._aplicar();
        }
      });
      const soltar = (e) => {
        if (!dedos.has(e.pointerId)) return;
        dedos.delete(e.pointerId);
        if (dedos.size === 1) {
          gesto = comecarArrasto([...dedos.values()][0]); // tirou um dedo: segue arrastando com o outro
        } else if (!dedos.size) {
          gesto = null;
          if (toque && e.type === "pointerup" && Date.now() - toque.t < 700) this._tocou(toque);
          toque = null;
        }
      };
      el.addEventListener("pointerup", soltar);
      el.addEventListener("pointercancel", soltar);
      el.addEventListener("wheel", (e) => {
        if (!this.W) return;
        e.preventDefault();
        const p = rel({ x: e.clientX, y: e.clientY });
        this.zoom(Math.exp(-e.deltaY * 0.0018), p.x, p.y);
      }, { passive: false });
      el.addEventListener("contextmenu", (e) => e.preventDefault());
    }

    _tocou(t) {
      const p = this._relativo(t);
      if (t.alvo) {
        clearTimeout(this._tempoToque);
        this._ultimo = null;
        this.onMarca?.(t.alvo.dataset.id);
        return;
      }
      const agora = Date.now();
      if (this._ultimo && agora - this._ultimo.t < 320 && Math.hypot(p.x - this._ultimo.x, p.y - this._ultimo.y) < 36) {
        // toque duplo: aproxima onde tocou (perto do máximo, volta para a folha inteira)
        clearTimeout(this._tempoToque);
        this._ultimo = null;
        if (this.s > this.sMin * ZOOM_MAX * 0.6) this.ajustar();
        else this._zoomPara(this.s * 2.5, p.x, p.y);
        return;
      }
      this._ultimo = { ...p, t: agora };
      const pos = this.paraFolha(p.x, p.y);
      clearTimeout(this._tempoToque);
      this._tempoToque = setTimeout(() => {
        this._ultimo = null;
        if (pos) this.onVazio?.(pos);
      }, 300);
    }
    _relativo(t) {
      const r = this.el.getBoundingClientRect();
      return { x: t.x - r.left, y: t.y - r.top };
    }
  }

  // ------------------------------------------------------------------ imagens para o PDF
  /** Desenha uma marca de ponto no canvas (bolinha e nome com contorno branco). */
  function desenharMarca(ctx, x, y, nome, cor, r) {
    // anel vazado (não cobre o projeto) com contorno branco e um pontinho no centro
    const anel = Math.max(2, r * 0.3);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = anel + Math.max(2, r * 0.25);
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.lineWidth = anel;
    ctx.strokeStyle = cor;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, r * 0.18), 0, Math.PI * 2);
    ctx.fillStyle = cor;
    ctx.fill();
    ctx.font = `700 ${Math.round(r * 2.1)}px Helvetica, Arial, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, r * 0.6);
    ctx.strokeStyle = "#fff";
    ctx.strokeText(nome, x + r * 1.5, y);
    ctx.fillStyle = cor;
    ctx.fillText(nome, x + r * 1.5, y);
  }

  /** Imagem (JPEG) da folha ou de um pedaço dela, com os pontos marcados.
   *  `recorte`: { x, y } fração da folha no centro, `largura` fração da largura da folha
   *  e `proporcao` largura/altura do pedaço. `marcas`: [{ nome, x, y, cor, destaque }]. */
  async function imagem(proj, { pag = 1, marcas = [], recorte = null, px = 2400, canvas = false } = {}) {
    const doc = await abrir(proj);
    const f = await folha(doc, Math.min(Math.max(1, pag), doc.paginas));
    let escala, dx = 0, dy = 0, w, h;
    if (recorte) {
      const lw = recorte.largura * f.W;
      w = px;
      h = Math.round(px / recorte.proporcao);
      escala = w / lw;
      dx = recorte.x * f.W * escala - w / 2;
      dy = recorte.y * f.H * escala - h / 2;
    } else {
      escala = Math.min(px / Math.max(f.W, f.H), Math.sqrt(BASE_AREA / (f.W * f.H)));
      w = Math.round(f.W * escala);
      h = Math.round(f.H * escala);
    }
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    await f.desenhar(ctx, escala, dx, dy, true).promise;
    const r = Math.max(6, Math.round(Math.max(w, h) / (recorte ? 100 : 130)));
    // as outras primeiro; a do ponto em destaque por cima
    for (const m of [...marcas].sort((a, b) => (a.destaque ? 1 : 0) - (b.destaque ? 1 : 0))) {
      desenharMarca(ctx, m.x * f.W * escala - dx, m.y * f.H * escala - dy, m.nome, m.cor, m.destaque ? r * 1.25 : r);
    }
    if (canvas) return { cv, w, h };
    return { url: cv.toDataURL("image/jpeg", 0.85), w, h };
  }

  async function paginas(proj) {
    return (await abrir(proj)).paginas;
  }

  const COR_COM = "#15803d"; // ponto com serviço lançado
  const COR_SEM = "#ea580c"; // ponto marcado, ainda sem serviço
  const COR_DESTAQUE = "#e11414";
  const PROPORCAO_RECORTE = 190 / 58; // faixa do croqui na folha de cada ponto do PDF

  /** Imagens do croqui para o PDF da medição: cada folha do projeto que tem ponto (a 1ª
   *  sempre) com todos os pontos marcados e, com `recortes`, um pedaço do croqui em volta
   *  de cada ponto, com ele em destaque. */
  async function paraPdf(obra, proj, { recortes = true } = {}) {
    const pontos = (obra.pontos || []).filter((p) => !p.geral && p.croqui);
    const total = await paginas(proj);
    const pags = [...new Set([1, ...pontos.map((p) => p.croqui.pag || 1)])].filter((n) => n <= total).sort((a, b) => a - b);
    const marcasDa = (pag, destaque) => pontos.filter((p) => (p.croqui.pag || 1) === pag).map((p) => ({
      nome: p.nome, x: p.croqui.x, y: p.croqui.y,
      cor: p === destaque ? COR_DESTAQUE : p.itens.length ? COR_COM : COR_SEM, destaque: p === destaque,
    }));
    const geral = [];
    for (const pag of pags) geral.push({ pag, total, ...(await imagem(proj, { pag, marcas: marcasDa(pag) })) });
    const porPonto = new Map();
    if (recortes) {
      for (const p of pontos) {
        const pag = p.croqui.pag || 1;
        porPonto.set(p.id, {
          pag,
          ...(await imagem(proj, {
            pag, marcas: marcasDa(pag, p), px: 1500,
            recorte: { x: p.croqui.x, y: p.croqui.y, largura: 0.42, proporcao: PROPORCAO_RECORTE },
          })),
        });
      }
    }
    return { geral, porPonto };
  }

  // ------------------------------------------------------------------ nome do poste (OCR)
  // O projeto impresso pelo "Microsoft Print to PDF" não tem texto: o nome do poste
  // (F.P1, P12...) é só desenho. O Tesseract lê um pedaço da folha em volta do toque.
  // Baixa uma vez (uns 7 MB, guardados pelo sw.js); sem ele, o nome fica o sugerido.
  const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  let leitor = null;
  function prepararLeitura() {
    if (!leitor) {
      leitor = (async () => {
        if (!window.Tesseract) {
          await new Promise((ok, falha) => {
            const s = document.createElement("script");
            s.src = TESSERACT;
            s.onload = ok;
            s.onerror = () => falha(new Error("Não deu para carregar o leitor de texto."));
            document.head.appendChild(s);
          });
        }
        // o sw.js já guarda o idioma: não precisa de outra cópia no banco do aparelho
        const w = await window.Tesseract.createWorker("eng", 1, { cacheMethod: "none" });
        await w.setParameters({ tessedit_pageseg_mode: "11" }); // palavras soltas pelo desenho
        return w;
      })().catch((e) => {
        leitor = null;
        throw e;
      });
    }
    return leitor;
  }

  // "F.P1", "P.12", "P7" → número do poste (o OCR às vezes troca 1 por l/I e 0 por O
  // e às vezes perde o ponto: "FP3")
  const ROTULO_POSTE = /^(?:[A-Z]{1,3}\.?)?P\.?([0-9LIO]{1,4})$/;

  /** Preto no branco: o rótulo é azul/vermelho/verde; o OCR lê bem melhor sem cor. */
  function pretoBranco(cv) {
    const ctx = cv.getContext("2d");
    const d = ctx.getImageData(0, 0, cv.width, cv.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const v = Math.min(p[i], p[i + 1], p[i + 2]) < 170 ? 0 : 255;
      p[i] = p[i + 1] = p[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }

  /** Nome do poste escrito no projeto mais perto de `pos` ({ pag, x, y } em fração da
   *  folha): { nome: "P1", texto: "F.P1" } ou null. */
  async function lerPoste(proj, pos) {
    // 2ª tentativa em outro tamanho: o OCR às vezes perde um número num deles
    for (const px of [840, 1050]) {
      const achou = await lerPosteEm(proj, pos, px);
      if (achou) return achou;
    }
    return null;
  }
  async function lerPosteEm(proj, pos, px) {
    const w = await prepararLeitura();
    const im = await imagem(proj, { pag: pos.pag || 1, px, canvas: true, recorte: { x: pos.x, y: pos.y, largura: 0.12, proporcao: 2 } });
    const { data } = await w.recognize(pretoBranco(im.cv), {}, { blocks: true });
    let melhor = null;
    for (const b of data.blocks || []) {
      for (const par of b.paragraphs) {
        for (const linha of par.lines) {
          for (const pal of linha.words) {
            // "(P1)" das notas do projeto não é o nome do poste: só a palavra sozinha vale
            const texto = pal.text.trim().toUpperCase().replace(/[,;:|]+$/, "");
            const m = ROTULO_POSTE.exec(texto);
            if (!m || pal.confidence < 25) continue;
            const num = m[1].replace(/[LI]/g, "1").replace(/O/g, "0");
            const { x0, x1, y0, y1 } = pal.bbox;
            // o rótulo com prefixo (F.P1) ganha de um "P1" solto perto do toque
            const d = Math.hypot((x0 + x1) / 2 - im.w / 2, (y0 + y1) / 2 - im.h / 2) + (texto.startsWith("P") ? im.w / 4 : 0);
            if (!melhor || d < melhor.d) melhor = { nome: "P" + num, texto, d };
          }
        }
      }
    }
    return melhor && { nome: melhor.nome, texto: melhor.texto };
  }

  window.Croqui = { Visor, imagem, paginas, paraPdf, prepararLeitura, lerPoste, COR_COM, COR_SEM };
})();
