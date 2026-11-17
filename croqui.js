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

  // ------------------------------------------------------------------ nome do ponto no branco
  /** Mapa de onde tem desenho num canvas (reduzido `f` vezes, em soma acumulada): diz
   *  rápido quanto desenho cai dentro de um retângulo. */
  function mapaTinta(cv, f = 2) {
    const W = cv.width, H = cv.height, gw = Math.ceil(W / f), gh = Math.ceil(H / f);
    const d = cv.getContext("2d").getImageData(0, 0, W, H).data;
    const tinta = new Uint8Array(gw * gh);
    for (let y = 0, i = 0; y < H; y++) {
      const linha = ((y / f) | 0) * gw;
      for (let x = 0; x < W; x++, i += 4) {
        if (Math.min(d[i], d[i + 1], d[i + 2]) < 200) tinta[linha + ((x / f) | 0)] = 1;
      }
    }
    const soma = new Uint32Array((gw + 1) * (gh + 1));
    for (let y = 0; y < gh; y++) {
      let acc = 0;
      for (let x = 0; x < gw; x++) {
        acc += tinta[y * gw + x];
        soma[(y + 1) * (gw + 1) + x + 1] = soma[y * (gw + 1) + x + 1] + acc;
      }
    }
    return { f, gw, gh, soma };
  }
  /** quanto desenho (em células do mapa) cai no retângulo { x0, y0, x1, y1 } em px do canvas */
  function tintaEm(m, r) {
    const lim = (v, max) => Math.max(0, Math.min(max, v));
    const a = lim(Math.floor(r.x0 / m.f), m.gw), b = lim(Math.floor(r.y0 / m.f), m.gh);
    const c = lim(Math.ceil(r.x1 / m.f), m.gw), e = lim(Math.ceil(r.y1 / m.f), m.gh);
    if (c <= a || e <= b) return 0;
    const L = m.gw + 1;
    return m.soma[e * L + c] - m.soma[b * L + c] - m.soma[e * L + a] + m.soma[b * L + a];
  }
  /** área (px²) do retângulo `r` que fica fora da imagem W x H (o nome não pode fugir dela) */
  function foraDa(r, W, H) {
    const dentro = Math.max(0, Math.min(r.x1, W) - Math.max(r.x0, 0)) * Math.max(0, Math.min(r.y1, H) - Math.max(r.y0, 0));
    return (r.x1 - r.x0) * (r.y1 - r.y0) - dentro;
  }
  /** área (px²) do retângulo `r` que cai em cima dos outros */
  function sobreposicao(r, outros) {
    let s = 0;
    for (const o of outros) s += Math.max(0, Math.min(r.x1, o.x1) - Math.max(r.x0, o.x0)) * Math.max(0, Math.min(r.y1, o.y1) - Math.max(r.y0, o.y0));
    return s;
  }
  /** Canto do nome (dx, dy do canto de cima à esquerda, a partir do ponto) com menor
   *  `custo`: à direita, à esquerda, nas diagonais, em cima e embaixo da bolinha de raio `r`;
   *  se em volta só tem desenho, vai se afastando na mesma direção até achar um branco
   *  (`longe`: precisa da linha fina ligando o nome ao ponto). */
  function melhorLugar(r, w, h, g, custo, unidade = 1) { // unidade: 1% do nome, no custo
    const d = r * 0.7;
    const perto = [
      [r + g, -h / 2], [-r - g - w, -h / 2],
      [d, -d - h], [d, d], [-d - w, -d - h], [-d - w, d],
      [-w / 2, -r - g - h], [-w / 2, r + g],
    ];
    let melhor = null;
    for (const [passo, afasta] of [0, 1, 2, 3, 4.5, 6].entries()) {
      perto.forEach(([dx, dy], k) => {
        // direção do ponto para o meio do nome
        const cx = dx + w / 2, cy = dy + h / 2, n = Math.hypot(cx, cy) || 1;
        const ex = (cx / n) * afasta * h, ey = (cy / n) * afasta * h;
        // empate: mais perto e na ordem acima (direita primeiro); longe custa um pouco
        const c = custo(dx + ex, dy + ey) + k * 0.2 * unidade + afasta * 3 * unidade + (passo ? 2 * unidade : 0);
        if (!melhor || c < melhor.c) melhor = { dx: dx + ex, dy: dy + ey, c, longe: afasta > 0 };
      });
    }
    return melhor;
  }
  /** ponto da borda do retângulo do nome mais perto do centro (para a linha fina) */
  function pontaDaGuia(dx, dy, w, h) {
    return [Math.max(dx, Math.min(0, dx + w)), Math.max(dy, Math.min(0, dy + h))];
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
      this._tinta = mapaTinta(this.base); // onde tem desenho: os nomes dos pontos fogem dele
      this._sNomes = null;
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
      this.marcasEl.innerHTML = lista.map((m) => `<button type="button" class="cq-marca ${m.classe || ""}" data-id="${esc(m.id)}" data-x="${m.x}" data-y="${m.y}" aria-label="${esc(m.nome)}"><i></i><b class="cq-guia" hidden></b><span>${esc(m.nome)}</span></button>`).join("");
      this._medidas = null; // tamanho dos nomes e das bolinhas: mede de novo
      this._sNomes = null;
      this._posicionarMarcas();
    }

    /** Põe o nome de cada ponto no lado com menos desenho do projeto em volta (para não
     *  cobrir as descrições), sem cair em cima de outro ponto. Só muda com o zoom. */
    _arrumarNomes() {
      if (!this._tinta || !this.W || this._sNomes === this.s) return;
      const bs = [...this.marcasEl.children];
      if (!bs.length) return;
      if (!this._medidas) {
        const med = bs.map((b) => {
          const sp = b.lastElementChild, ic = b.firstElementChild;
          return { w: sp.offsetWidth, h: sp.offsetHeight, r: ic.offsetWidth / 2 };
        });
        if (med.some((m) => !m.w)) return; // visor ainda fora da tela: mede depois
        this._medidas = med;
      }
      this._sNomes = this.s;
      const k = this.sb / this.s; // px da tela → px da imagem base
      const pts = bs.map((b, i) => ({ x: Number(b.dataset.x) * this.W * this.sb, y: Number(b.dataset.y) * this.H * this.sb, ...this._medidas[i] }));
      const ocupados = pts.map((p) => ({ x0: p.x - p.r * k, y0: p.y - p.r * k, x1: p.x + p.r * k, y1: p.y + p.r * k }));
      // o ponto escolhido arruma o nome primeiro
      const ordem = pts.map((_, i) => i).sort((a, c) => (bs[c].classList.contains("cq-sel") ? 1 : 0) - (bs[a].classList.contains("cq-sel") ? 1 : 0));
      for (const i of ordem) {
        const p = pts[i];
        const f2 = this._tinta.f * this._tinta.f;
        const lugar = melhorLugar(p.r, p.w, p.h, 3, (dx, dy) => {
          const ret = { x0: p.x + dx * k, y0: p.y + dy * k, x1: p.x + (dx + p.w) * k, y1: p.y + (dy + p.h) * k };
          return tintaEm(this._tinta, ret) + (sobreposicao(ret, ocupados) + foraDa(ret, this.base.width, this.base.height)) * 4 / f2;
        }, (p.w * p.h * k * k) / f2 / 100);
        ocupados.push({ x0: p.x + lugar.dx * k, y0: p.y + lugar.dy * k, x1: p.x + (lugar.dx + p.w) * k, y1: p.y + (lugar.dy + p.h) * k });
        bs[i].lastElementChild.style.transform = `translate(${Math.round(lugar.dx)}px, ${Math.round(lugar.dy)}px)`;
        // nome afastado: linha fina da bolinha até ele
        const guia = bs[i].querySelector(".cq-guia");
        if (lugar.longe) {
          const [gx, gy] = pontaDaGuia(lugar.dx, lugar.dy, p.w, p.h);
          const comp = Math.hypot(gx, gy) - p.r;
          guia.style.width = `${Math.max(0, comp)}px`;
          guia.style.transform = `rotate(${Math.atan2(gy, gx)}rad) translateX(${p.r}px)`;
          guia.hidden = comp <= 2;
        } else guia.hidden = true;
      }
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
      this._arrumarNomes();
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
  const fonteMarca = (r) => `700 ${Math.round(r * 2.1)}px Helvetica, Arial, sans-serif`;

  /** Desenha uma marca de ponto no canvas: bolinha e o nome com contorno branco, com o
   *  canto de cima à esquerda do nome em (x + lx, y + ly). */
  function desenharMarca(ctx, x, y, nome, cor, r, lx = r * 1.5, ly = -r * 1.05) {
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
    ctx.font = fonteMarca(r);
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, r * 0.6);
    ctx.strokeStyle = "#fff";
    ctx.strokeText(nome, x + lx, y + ly + r * 1.05);
    ctx.fillStyle = cor;
    ctx.fillText(nome, x + lx, y + ly + r * 1.05);
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
    // o nome de cada ponto vai para o lado com menos desenho (não cobre as descrições)
    const tinta = marcas.length ? mapaTinta(cv, 2) : null;
    const pts = marcas.map((m) => {
      const rm = m.destaque ? r * 1.25 : r;
      ctx.font = fonteMarca(rm);
      return { m, x: m.x * f.W * escala - dx, y: m.y * f.H * escala - dy, r: rm, w: ctx.measureText(m.nome).width, h: rm * 2.1 };
    });
    const ocupados = pts.map((p) => ({ x0: p.x - p.r, y0: p.y - p.r, x1: p.x + p.r, y1: p.y + p.r }));
    for (const p of [...pts].sort((a, b) => (b.m.destaque ? 1 : 0) - (a.m.destaque ? 1 : 0))) {
      const f2 = tinta.f * tinta.f;
      const l = melhorLugar(p.r, p.w, p.h, p.r * 0.4, (lx, ly) => {
        const ret = { x0: p.x + lx, y0: p.y + ly, x1: p.x + lx + p.w, y1: p.y + ly + p.h };
        return tintaEm(tinta, ret) + (sobreposicao(ret, ocupados) + foraDa(ret, w, h)) * 4 / f2;
      }, (p.w * p.h) / f2 / 100);
      p.lx = l.dx;
      p.ly = l.dy;
      p.longe = l.longe;
      ocupados.push({ x0: p.x + l.dx, y0: p.y + l.dy, x1: p.x + l.dx + p.w, y1: p.y + l.dy + p.h });
    }
    // as outras primeiro; a do ponto em destaque por cima
    for (const p of [...pts].sort((a, b) => (a.m.destaque ? 1 : 0) - (b.m.destaque ? 1 : 0))) {
      if (p.longe) {
        // nome afastado para achar um branco: linha fina da bolinha até ele
        const [gx, gy] = pontaDaGuia(p.lx, p.ly, p.w, p.h);
        const n = Math.hypot(gx, gy) || 1;
        ctx.beginPath();
        ctx.moveTo(p.x + (gx / n) * p.r, p.y + (gy / n) * p.r);
        ctx.lineTo(p.x + gx, p.y + gy);
        ctx.lineWidth = Math.max(1, p.r * 0.15) + 2;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.lineWidth = Math.max(1, p.r * 0.15);
        ctx.strokeStyle = p.m.cor;
        ctx.stroke();
      }
      desenharMarca(ctx, p.x, p.y, p.m.nome, p.m.cor, p.r, p.lx, p.ly);
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
  // dois leitores: as duas passadas da leitura do projeto (tudo e só o vermelho) rodam juntas
  const leitores = new Map();
  let carregandoTesseract = null;
  function prepararLeitura(n = 1) {
    if (!leitores.has(n)) {
      leitores.set(n, (async () => {
        if (!window.Tesseract) {
          carregandoTesseract = carregandoTesseract || new Promise((ok, falha) => {
            const s = document.createElement("script");
            s.src = TESSERACT;
            s.onload = ok;
            s.onerror = () => falha(new Error("Não deu para carregar o leitor de texto."));
            document.head.appendChild(s);
          });
          await carregandoTesseract;
        }
        // o sw.js já guarda o idioma: não precisa de outra cópia no banco do aparelho
        const w = await window.Tesseract.createWorker("eng", 1, { cacheMethod: "none" });
        await w.setParameters({ tessedit_pageseg_mode: "11" }); // palavras soltas pelo desenho
        return w;
      })().catch((e) => {
        leitores.delete(n);
        carregandoTesseract = null;
        throw e;
      }));
    }
    return leitores.get(n);
  }


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
  function lerPoste(proj, pos) {
    return naFila(async () => {
      // lê em tamanhos diferentes e fica com o nome que mais se repete: o OCR às vezes troca
      // um número num deles ("(P5)" lido "(P3)")
      const votos = new Map();
      for (const px of window.CROQUI_TAMANHOS || [700, 900, 1150]) {
        const achou = await lerPosteEm(proj, pos, px);
        if (!achou) continue;
        const v = votos.get(achou.nome) || { ...achou, n: 0 };
        v.n++;
        v.comP = v.comP || achou.comP;
        v.perto = Math.min(v.perto ?? 1, achou.perto ?? 1);
        votos.set(achou.nome, v);
        if (v.n >= 2) break; // dois iguais: decidido
      }
      const melhor = [...votos.values()].sort((a, b) => b.n - a.n)[0];
      // comP: o "P" apareceu na leitura (sem ele pode ser um símbolo verde do desenho)
      // perto: distância do rótulo lido ao toque (fração do recorte)
      return melhor ? { nome: melhor.nome, texto: melhor.texto, comP: !!melhor.comP, perto: melhor.perto ?? 1 } : null;
    });
  }

  // uma leitura de cada vez: a releitura da quantidade muda o modo do leitor por um instante
  let filaOcr = Promise.resolve();
  function naFila(fn) {
    const vez = filaOcr.then(fn, fn);
    filaOcr = vez.catch(() => {});
    return vez;
  }
  async function lerPosteEm(proj, pos, px) {
    const w = await prepararLeitura();
    const im = await imagem(proj, { pag: pos.pag || 1, px, canvas: true, recorte: { x: pos.x, y: pos.y, largura: 0.12, proporcao: 2 } });
    // projeto torto, em pé ou de cabeça para baixo: endireita e tenta cada ângulo até achar.
    // Vale de cara só a leitura com o "P" na frente do número: de cabeça para baixo o
    // "(P68)" vira "(89d)" e, sem o P, saía "P89" (o 6 vira 9 e a ordem inverte)
    let reserva = null;
    for (const ang of await angulosDe(proj, pos.pag || 1, im.cv)) {
      const achou = await lerPosteGirado(w, ang ? girar(im.cv, ang) : im.cv);
      if (achou?.comP) return { nome: achou.nome, texto: achou.texto, comP: true, perto: achou.perto };
      if (achou?.nome && !achou.virado && !reserva) reserva = { nome: achou.nome, texto: achou.texto, comP: false, perto: achou.perto };
    }
    return reserva;
  }
  async function lerPosteGirado(w, colorido) {
    const im = { w: colorido.width, h: colorido.height };
    // só o verde vai para o OCR: o "(P4)" fica sozinho (colado na caixa vermelha, saía
    // "(P4)DT11/600" numa palavra só) e as linhas pretas e vermelhas não confundem
    const pb = document.createElement("canvas");
    pb.width = colorido.width;
    pb.height = colorido.height;
    const pctx = pb.getContext("2d");
    pctx.drawImage(colorido, 0, 0);
    const dados = pctx.getImageData(0, 0, pb.width, pb.height), px = dados.data;
    for (let i = 0; i < px.length; i += 4) {
      const verde = Math.min(px[i], px[i + 1], px[i + 2]) < 200 && px[i + 1] > px[i] + 50 && px[i + 1] > px[i + 2] + 30;
      px[i] = px[i + 1] = px[i + 2] = verde ? 0 : 255;
    }
    pctx.putImageData(dados, 0, 0);
    // só os caracteres de um "(P12)": o OCR não troca 5 por S ou 6 por 8 tão fácil.
    // O "d" é o P de cabeça para baixo: denuncia que o ângulo está invertido
    await w.setParameters({ tessedit_char_whitelist: "()P0123456789d" });
    let data;
    try {
      ({ data } = await w.recognize(pb, {}, { blocks: true }));
    } finally {
      await w.setParameters({ tessedit_char_whitelist: "" });
    }
    let melhor = null, virado = false;
    for (const b of data.blocks || []) {
      for (const par of b.paragraphs) {
        for (const linha of par.lines) {
          for (const pal of linha.words) {
            const bruto = pal.text.trim().replace(/[,;:|]+$/, "");
            // "(89d)": rótulo de cabeça para baixo neste ângulo, não é o número
            if (/^\(?\d{1,3}d\)?$/.test(bruto)) { virado = true; continue; }
            // o ponto é identificado só pelo "(P2)" VERDE do projeto (supervisor, 17/11/2026):
            // o F.P2 azul não vale, nem o "(P1)" vermelho/cinza das notas
            const m = APELIDO.exec(bruto.replace(/d/g, "").toUpperCase());
            if (!m || !/[()]/.test(pal.text)) continue;
            const num = m[1].replace(/[LI]/g, "1").replace(/O/g, "0");
            if (!/^\d+$/.test(num)) continue;
            const { x0, x1, y0, y1 } = pal.bbox;
            const d = Math.hypot((x0 + x1) / 2 - im.w / 2, (y0 + y1) / 2 - im.h / 2);
            const comP = /P\d/.test(bruto);
            // o com P na frente vale mais que um sem P mais perto do toque
            if (!melhor || (comP && !melhor.comP) || (comP === melhor.comP && d < melhor.d)) {
              melhor = { nome: "P" + Number(num), texto: `(P${Number(num)})`, d, comP };
            }
          }
        }
      }
    }
    return melhor ? { nome: melhor.nome, texto: melhor.texto, comP: melhor.comP, virado, perto: melhor.d / Math.max(im.w, im.h) } : virado ? { virado: true } : null;
  }

  // "(P2)" verde do projeto (o OCR às vezes perde um parêntese ou o P: "(P2", "2)")
  const APELIDO = /^\(?P?([0-9LIO]{1,3})\)?$/;

  /** cor que mais aparece na tinta do retângulo `b` de um canvas colorido */
  function corEm(cv, b) {
    const x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
    const w = Math.min(cv.width, Math.ceil(b.x1)) - x0, h = Math.min(cv.height, Math.ceil(b.y1)) - y0;
    if (w <= 0 || h <= 0) return "";
    const d = cv.getContext("2d").getImageData(x0, y0, w, h).data;
    const n = { vermelho: 0, cinza: 0, preto: 0, azul: 0, verde: 0 };
    for (let i = 0; i < d.length; i += 4) {
      if (Math.min(d[i], d[i + 1], d[i + 2]) >= 170) continue;
      const c = corPixel(d[i], d[i + 1], d[i + 2]);
      if (c) n[c]++;
    }
    return Object.entries(n).sort((a, c) => c[1] - a[1])[0][0];
  }

  // ------------------------------------------------------------------ serviços escritos no projeto
  // Ao lado de cada poste o projeto escreve o que muda nele: em vermelho (caixas) o que
  // entra ("INST. RELIGADOR NA", "DT12/1000 1-B4 1-SI1"), em cinza riscado o que sai
  // ("DT11/600 1-CE4"), em preto o que fica. A pilha de caixas termina na mesma linha do
  // rótulo do poste (F.P2), à esquerda dele.

  function corPixel(r, g, b) {
    if (r > g + 60 && r > b + 60) return "vermelho";
    if (b > r + 60 && b > g + 30) return "azul";
    if (g > r + 60 && g > b + 30) return "verde";
    if (Math.max(r, g, b) < 70) return "preto";
    if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30) return "cinza";
    return "";
  }

  /** Tinta em preto no branco para o OCR, sem as retas compridas (borda das caixas e o risco
   *  do que vai sair: atrapalham a leitura) e com as letras que o risco cortou recompostas.
   *  `so`: só a tinta dessa cor. */
  function mascara(cv, so) {
    const W = cv.width, H = cv.height, L = Math.round(W * 0.03);
    const orig = cv.getContext("2d").getImageData(0, 0, W, H).data;
    const m = new Uint8Array(W * H), apag = new Uint8Array(W * H);
    for (let k = 0, i = 0; k < m.length; k++, i += 4) {
      const r = orig[i], g = orig[i + 1], b = orig[i + 2];
      if (Math.min(r, g, b) >= 170) continue;
      if (so && corPixel(r, g, b) !== so) continue;
      m[k] = 1;
    }
    for (let y = 0; y < H; y++) {
      let ini = -1;
      for (let x = 0; x <= W; x++) {
        const on = x < W && m[y * W + x];
        if (on && ini < 0) ini = x;
        if (!on && ini >= 0) {
          if (x - ini > L) for (let z = ini; z < x; z++) { m[y * W + z] = 0; apag[y * W + z] = 1; }
          ini = -1;
        }
      }
    }
    // a haste da letra que o risco cortou: tem tinta logo acima e logo abaixo do risco
    const volta = [];
    for (let k = 0; k < m.length; k++) {
      if (!apag[k]) continue;
      let cima = false, baixo = false;
      for (let a = 1, j = k - W; a <= 4 && j >= 0; a++, j -= W) { if (m[j]) { cima = true; break; } if (!apag[j]) break; }
      for (let a = 1, j = k + W; a <= 4 && j < m.length; a++, j += W) { if (m[j]) { baixo = true; break; } if (!apag[j]) break; }
      if (cima && baixo) volta.push(k);
    }
    for (const k of volta) m[k] = 1;
    // borda lateral das caixas: reta em pé que encosta numa borda apagada em cima e embaixo
    // (grudada na letra, o OCR quebra a palavra; o "1" solto do 118106 não encosta em nada)
    const encosta = (x, y) => {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < H && xx >= 0 && xx < W && apag[yy * W + xx]) return true;
      }
      return false;
    };
    const tirar = [];
    for (let x = 0; x < W; x++) {
      let ini = -1;
      for (let y = 0; y <= H; y++) {
        const on = y < H && m[y * W + x];
        if (on && ini < 0) ini = y;
        if (!on && ini >= 0) {
          if (y - ini >= 12 && encosta(x, ini) && encosta(x, y - 1)) for (let z = ini; z < y; z++) tirar.push(z * W + x);
          ini = -1;
        }
      }
    }
    for (const k of tirar) m[k] = 0;
    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const ctx = out.getContext("2d");
    const d = ctx.createImageData(W, H);
    for (let k = 0, i = 0; k < m.length; k++, i += 4) {
      const v = m[k] ? 0 : 255;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      d.data[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    return { cv: out, m, apag, orig, W };
  }

  /** Cor da linha (a que mais aparece na tinta dela, fora o risco) e se está riscada. */
  function corDaLinha(mk, b) {
    const n = { vermelho: 0, cinza: 0, preto: 0, azul: 0, verde: 0 };
    let maxRisco = 0;
    const meio0 = b.y0 + (b.y1 - b.y0) * 0.2, meio1 = b.y1 - (b.y1 - b.y0) * 0.2;
    for (let y = b.y0; y < b.y1; y++) {
      let risco = 0;
      for (let x = b.x0; x < b.x1; x++) {
        const k = y * mk.W + x;
        if (mk.apag[k]) { risco++; continue; }
        if (!mk.m[k]) continue;
        const c = corPixel(mk.orig[k * 4], mk.orig[k * 4 + 1], mk.orig[k * 4 + 2]);
        if (c) n[c]++;
      }
      if (y >= meio0 && y <= meio1) maxRisco = Math.max(maxRisco, risco);
    }
    const cor = Object.entries(n).sort((a, c) => c[1] - a[1])[0][0];
    return { cor, riscada: maxRisco > (b.x1 - b.x0) * 0.4 };
  }

  async function linhasDe(w, cv) {
    const { data } = await w.recognize(cv, {}, { blocks: true });
    const linhas = [];
    for (const b of data.blocks || []) for (const par of b.paragraphs) for (const l of par.lines) {
      linhas.push({ bbox: l.bbox, palavras: l.words.map((p) => ({ texto: p.text.trim().toUpperCase(), bbox: p.bbox, conf: p.confidence })) });
    }
    return linhas;
  }

  const limparLinha = (t) => t.replace(/[[\]|~“”"‘’_]+/g, " ").replace(/\s+/g, " ").trim();

  /** O que o projeto escreve no poste mais perto de `pos`:
   *  { poste: "F.P2", apelido: "(P1)", linhas: [{ texto, cor, riscada }] } ou null. */
  /** `nome`: o nome do ponto (P2), quando ele foi criado tocando no "(P2)" do projeto */
  function lerProjeto(proj, pos, nome = "") {
    return naFila(() => lerProjetoAgora(proj, pos, /^P\d+$/.test(nome) ? nome : ""));
  }

  /** Quantidade que o OCR leu errado por causa da caixa: "OCF" (9CF = 9 chaves faca) ou
   *  "13 - 100A - 5H" (a borda virou "1" na frente do 3). Relê só aquela caixa, sem a
   *  borda, aceitando só os caracteres de `lista`; `re` tira a quantidade do texto lido. */
  async function relerQuantidade(w, cv, b, lista = "0123456789CF-", re = /(\d{1,2})C?F/) {
    const pad = Math.round((b.y1 - b.y0) * 0.3);
    const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad);
    const W = Math.min(cv.width, b.x1 + pad) - x0, H = Math.min(cv.height, b.y1 + pad) - y0;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d");
    ctx.drawImage(cv, x0, y0, W, H, 0, 0, W, H);
    // tira a borda da caixa (reta em pé mais alta que as letras): viraria "1" na frente do 9
    const d = ctx.getImageData(0, 0, W, H), p = d.data, alta = (b.y1 - b.y0) * 0.85;
    for (let x = 0; x < W; x++) {
      let ini = -1;
      for (let y = 0; y <= H; y++) {
        const on = y < H && p[(y * W + x) * 4] < 128;
        if (on && ini < 0) ini = y;
        if (!on && ini >= 0) {
          if (y - ini >= alta) for (let z = ini; z < y; z++) { const i = (z * W + x) * 4; p[i] = p[i + 1] = p[i + 2] = 255; }
          ini = -1;
        }
      }
    }
    ctx.putImageData(d, 0, 0);
    await w.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: lista });
    try {
      const { data } = await w.recognize(c);
      const m = re.exec(data.text.replace(/\s+/g, ""));
      if (window.CROQUI_DEPURAR) (window.CROQUI_RELER = window.CROQUI_RELER || []).push({ texto: data.text, img: c.toDataURL() });
      return m ? m[1] : "";
    } finally {
      await w.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "" });
    }
  }

  /** Inclinação (graus) das caixas de texto do recorte: há projeto que escreve tudo torto,
   *  acompanhando a rua. As bordas retas das caixas servem de régua: o ângulo em que elas
   *  ficam deitadas é o que dá mais traços horizontais compridos. */
  function inclinacao(cv) {
    // em toda a volta (deitado, em pé, na diagonal): a reta deitada tanto faz para que lado,
    // então basta de -90° a +90°; de cabeça para baixo (+180°) quem decide é a leitura
    const f = 4, w = Math.round(cv.width / f), h = Math.round(cv.height / f), L = Math.round(Math.min(w, h) * 0.05);
    const lado = Math.ceil(Math.hypot(w, h)); // girado não perde os cantos
    const pequeno = document.createElement("canvas");
    pequeno.width = w;
    pequeno.height = h;
    pequeno.getContext("2d").drawImage(cv, 0, 0, w, h);
    const giro = document.createElement("canvas");
    giro.width = lado;
    giro.height = lado;
    const gc = giro.getContext("2d", { willReadFrequently: true });
    const medir = (ang, soVermelho) => {
      gc.setTransform(1, 0, 0, 1, 0, 0);
      gc.fillStyle = "#fff";
      gc.fillRect(0, 0, lado, lado);
      gc.translate(lado / 2, lado / 2);
      gc.rotate((-ang * Math.PI) / 180);
      gc.drawImage(pequeno, -w / 2, -h / 2);
      const d = gc.getImageData(0, 0, lado, lado).data;
      let total = 0;
      for (let y = 0; y < lado; y++) {
        let corrida = 0;
        for (let x = 0; x <= lado; x++) {
          let on = false;
          if (x < lado) {
            const i = (y * lado + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
            on = Math.min(r, g, b) < 170 && (!soVermelho || (r > g + 60 && r > b + 60));
          }
          if (on) corrida++;
          else { if (corrida > L) total += corrida * corrida; corrida = 0; } // reta comprida vale mais
        }
      }
      return total;
    };
    // de 5 em 5 graus, os mais perto do reto primeiro (empate fica com o mais reto)
    const grossos = [0];
    for (let a = 5; a < 90; a += 5) grossos.push(a, -a);
    grossos.push(90);
    // primeiro pelas caixas vermelhas; sem elas, por todo o desenho
    for (const soVermelho of [true, false]) {
      let melhor = null;
      for (const a of grossos) {
        const v = medir(a, soVermelho);
        if (!melhor || v > melhor.v * 1.05) melhor = { ang: a, v };
      }
      if (melhor.v > L * L * 4) {
        // afina em volta do melhor: de grau em grau, meio grau e quarto de grau
        for (const [passo, n] of [[1, 3], [0.5, 1], [0.25, 1]]) {
          const ini = melhor.ang;
          for (let a = ini - passo * n; a <= ini + passo * n; a += passo) {
            if (a === ini) continue;
            const v = medir(a, soVermelho);
            if (v > melhor.v) melhor = { ang: a, v };
          }
        }
        return melhor.ang > 90 ? melhor.ang - 180 : melhor.ang <= -90 ? melhor.ang + 180 : melhor.ang;
      }
    }
    return 0;
  }

  /** Inclinação da folha inteira (uma vez por projeto): o projeto costuma ser todo torto do
   *  mesmo jeito, e num recorte com pouca caixa a régua sai errada. */
  const inclinacoesDaFolha = new Map();
  function inclinacaoDaFolha(proj, pag) {
    const k = `${chaveDe(proj)}|${pag}`;
    if (!inclinacoesDaFolha.has(k)) {
      inclinacoesDaFolha.set(k, imagem(proj, { pag, px: 1800, canvas: true }).then((im) => inclinacao(im.cv)).catch(() => 0));
    }
    return inclinacoesDaFolha.get(k);
  }
  /** ângulos para tentar a leitura, na ordem: o do recorte, o da folha, reto, e cada um
   *  deles de cabeça para baixo (+180°) */
  async function angulosDe(proj, pag, cv) {
    const lista = [];
    const por = (a) => {
      let v = Math.abs(a) < 1 ? 0 : a;
      if (v > 180) v -= 360;
      if (v <= -180) v += 360;
      if (!lista.some((x) => Math.abs(x - v) < 0.75)) lista.push(v);
    };
    // o do recorte primeiro (é o do texto em volta do ponto); o da folha ajuda quando o
    // recorte tem pouca caixa para servir de régua
    const base = [inclinacao(cv), await inclinacaoDaFolha(proj, pag), 0];
    base.forEach(por);
    base.forEach((a) => por((Math.abs(a) < 1 ? 0 : a) + 180));
    return lista;
  }

  // o que se escreve num projeto: poste, estrutura, chave, transformador e as palavras dos serviços
  const VOCABULARIO = new RegExp([
    String.raw`D?T\s?\d{1,2}\s?[/1]\s?\d{3,4}`, String.raw`\b\d{1,2}\s?-\s?[A-Z]{1,3}\d[A-Z]?\b`,
    String.raw`\b\d{1,2}\s?-\s?\d{2,3}\s?A\b`, String.raw`\b\d{1,2}\s?CF\b`, String.raw`\bTR\s?-?\s?\d\s?-?\s?\d+\s?KVA`,
    String.raw`\b(ATERRAMENTO|TEMPORARIO|RELIGADOR|DEFENSA|LINHA|VIVA|INST|ISOL|SUSPENSAO|APROVEITAR|TRAFO|TRANSFORMADOR|CHAVE|CRUZETA|ESTAI|POSTE|ABRIR|RETIRAR|INSTALAR)\b`,
  ].join("|"), "g");
  const pontosDoTexto = (t) => {
    const s = t.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
    return [...s.matchAll(VOCABULARIO)].reduce((n, m) => n + m[0].replace(/\s/g, "").length, 0);
  };

  /** o recorte girado em volta do meio, para deixar o texto deitado (a tela cresce para
   *  caber o recorte inteiro girado: em pé ou na diagonal não perde nada) */
  function girar(cv, ang) {
    const rad = (-ang * Math.PI) / 180, cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const c = document.createElement("canvas");
    c.width = Math.ceil(cv.width * cos + cv.height * sin);
    c.height = Math.ceil(cv.width * sin + cv.height * cos);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(cv, -cv.width / 2, -cv.height / 2);
    return c;
  }

  // tempo de cada etapa da leitura (só no teste: window.CROQUI_DEPURAR)
  const marcarTempo = (etapa, t0) => { if (window.CROQUI_DEPURAR) (window.CROQUI_TEMPOS = window.CROQUI_TEMPOS || []).push(`${etapa} ${Math.round(performance.now() - t0)}ms`); };

  async function lerProjetoAgora(proj, pos, nome) {
    let t0 = performance.now();
    const w = await prepararLeitura();
    marcarTempo("leitor", t0);
    // recorte quadrado: com o projeto em pé (90°) o texto corre na vertical e precisa da
    // mesma folga para cima e para baixo que teria para os lados
    t0 = performance.now();
    const im = await imagem(proj, { pag: pos.pag || 1, px: 1700, canvas: true, recorte: { x: pos.x, y: pos.y, largura: 0.3, proporcao: 1 } });
    marcarTempo("recorte", t0);
    // texto torto: lê também com o recorte endireitado (girado em volta do meio, que é o
    // ponto tocado). Pode ter caixa reta e torta juntas: fica a leitura que achou mais
    // texto deste poste.
    t0 = performance.now();
    const angulos = window.CROQUI_ANGULOS || (await angulosDe(proj, pos.pag || 1, im.cv)); // (CROQUI_ANGULOS: só para teste)
    marcarTempo("inclinação", t0);
    if (window.CROQUI_DEPURAR) window.CROQUI_ANG = angulos;
    let melhor = null;
    for (const a of angulos) {
      t0 = performance.now();
      const r = await analisar(w, a ? girar(im.cv, a) : im.cv, nome);
      marcarTempo(`leitura a ${a}°`, t0);
      // vale a leitura com o (P) mais perto do ponto tocado e o texto mais bem lido: de cabeça
      // para baixo o OCR acha "letras", mas com pouca confiança
      // vale pelo que dá para reconhecer do projeto (DT11/1000, 1-CE3, 3-100A, ATERRAMENTO,
      // INST...): de cabeça para baixo ou picado ("ATERRAME" + "NTO") quase não pontua. A
      // confiança do OCR sozinha engana (dá 92 para um pedaço e 37 para a palavra certa).
      const nota = r ? r.linhas.reduce((s, l) => s + pontosDoTexto(l.texto), 0) - (r.distancia / (im.w * 0.05)) * 3 : -Infinity;
      const conf = r?.linhas.length ? r.linhas.reduce((s, l) => s + l.conf, 0) / r.linhas.length : 0;
      if (window.CROQUI_DEPURAR) (window.CROQUI_NOTAS = window.CROQUI_NOTAS || []).push({ a, nota: Math.round(nota), conf: Math.round(conf), dist: r && Math.round(r.distancia), linhas: r && r.linhas.map((l) => `${l.texto} (${Math.round(l.conf)})`) });
      if (!melhor || nota > melhor.nota) melhor = { r, nota };
      // leitura que reconhece bastante do projeto, no ponto: basta (não lê nos outros ângulos)
      if (r?.linhas.length && r.distancia < im.w * 0.1 && nota >= 25) break;
      // os de cabeça para baixo (+180°) vêm no fim da lista: só se nenhuma leitura prestou
      if (Math.abs(a) > 90 && melhor.nota >= 12) break;
      const proximo = angulos[angulos.indexOf(a) + 1];
      if (proximo !== undefined && Math.abs(proximo) > 90 && melhor.nota >= 12) break;
    }
    if (melhor.r) {
      delete melhor.r.distancia;
      melhor.r.linhas.forEach((l) => delete l.conf);
    }
    return melhor.r;
  }

  /** lê o recorte (já endireitado) e separa o que é do poste do meio dele */
  async function analisar(w, base, nome = "") {
    const im = { w: base.width, h: base.height };
    let t0 = performance.now();
    const tudo = mascara(base);
    const verm = mascara(base, "vermelho"); // o vermelho sozinho sai mais limpo
    marcarTempo("  máscaras", t0);
    // as duas passadas ao mesmo tempo, cada uma num leitor
    t0 = performance.now();
    const w2 = await prepararLeitura(2).catch(() => w);
    const [linhasTudo, linhasVerm] = await Promise.all([linhasDe(w, tudo.cv), linhasDe(w2, verm.cv)]);
    marcarTempo("  OCR (as duas)", t0);
    for (const l of linhasVerm) {
      const k = l.palavras.findIndex((p) => /CF/.test(p.texto));
      if (k < 0 || /^\d{1,2}CF/.test(l.palavras[k].texto) || (k > 0 && /^\d{1,2}$/.test(l.palavras[k - 1].texto))) continue;
      const n = await relerQuantidade(w, verm.cv, l.bbox);
      if (n) l.palavras[k] = { ...l.palavras[k], texto: l.palavras[k].texto.replace(/^[^C]*CF/, `${n}CF`) };
    }
    // chave fusível "3 - 100A - 5H": a borda da caixa vira "1" na frente da quantidade (13)
    for (const l of linhasVerm) {
      const t = l.palavras.map((p) => p.texto).join(" ");
      if (!/\d{1,3}\s?-\s?\d{2,3}\s?A/.test(t)) continue;
      const n = await relerQuantidade(w, verm.cv, l.bbox, "0123456789-A,H", /(?:^|-)(\d{1,2})-\d{2,3}A/);
      const k = l.palavras.findIndex((p) => /\d/.test(p.texto));
      if (n && k >= 0) l.palavras[k] = { ...l.palavras[k], texto: l.palavras[k].texto.replace(/^\D*\d{1,3}/, n) };
    }

    // o ponto é identificado só pelo "(P2)" VERDE do projeto (supervisor, 17/11/2026): o F.P2
    // azul não serve de referência, e o "(P1)" das notas é vermelho/cinza
    const rotulos = [];
    for (const l of linhasTudo) {
      for (const p of l.palavras) {
        const ap = /[()]/.test(p.texto) ? APELIDO.exec(p.texto) : null;
        const num = ap && ap[1].replace(/[LI]/g, "1").replace(/O/g, "0");
        if (!num || !/^\d+$/.test(num) || num.length > 2 || p.conf < 40 || corDaLinha(tudo, p.bbox).cor !== "verde") continue;
        const texto = `(P${Number(num)})`;
        rotulos.push({ texto, bbox: p.bbox, apelido: texto, ancoras: [p.bbox] });
      }
    }
    const cx = im.w / 2, cy = im.h / 2;
    const centro = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    const longeDoMeio = (r) => Math.min(...r.ancoras.map((b) => Math.hypot(centro(b)[0] - cx, centro(b)[1] - cy)));
    // o ponto já sabe o nome (P2, lido quando foi criado tocando no "(P2)"): se o OCR deste
    // recorte maior não achou o (P2), ele está onde o ponto foi marcado, no meio do recorte
    const alvo = nome ? `(${nome})` : "";
    let nosso = alvo && rotulos.find((r) => r.texto === alvo && longeDoMeio(r) < im.w * 0.3);
    if (!nosso && alvo && /^\(P\d+\)$/.test(alvo)) {
      const hs = [...linhasTudo, ...linhasVerm].map((l) => l.bbox.y1 - l.bbox.y0).sort((a, b) => a - b);
      const h = hs.length ? hs[hs.length >> 1] : im.w * 0.02;
      nosso = { texto: alvo, apelido: alvo, bbox: { x0: cx - h * 1.5, y0: cy - h / 2, x1: cx + h * 1.5, y1: cy + h / 2 } };
      nosso.ancoras = [nosso.bbox];
      rotulos.push(nosso);
    }
    if (!rotulos.length) return null;
    if (!nosso) nosso = rotulos.reduce((a, r) => (longeDoMeio(r) < longeDoMeio(a) ? r : a));
    // o rótulo do poste tocado não foi lido: não usa o de outro poste mais longe
    // (o ponto pode estar no poste, que fica a um palmo do rótulo; bem mais longe já é outro)
    if (longeDoMeio(nosso) > im.w * 0.3) return null;

    // linhas com serviço: vermelhas (do 2º OCR) e cinzas (riscadas = sai; sem risco = nota)
    const linhas = [];
    const guardar = (l, cor, riscada) => {
      const texto = limparLinha(l.palavras.map((p) => p.texto).join(" "));
      if (!/[A-Z]{3,}|\d+\s?-\s?[A-Z]{1,3}\d|\d{3,}/.test(texto)) return; // risco solto, pedaço de símbolo
      const conf = l.palavras.reduce((s, p) => s + (p.conf || 0), 0) / Math.max(1, l.palavras.length);
      linhas.push({ texto, cor, riscada, conf, bbox: l.bbox, h: Math.max(8, l.bbox.y1 - l.bbox.y0) });
    };
    for (const l of linhasVerm) guardar(l, "vermelho", false);
    for (const l of linhasTudo) {
      const { cor, riscada } = corDaLinha(tudo, l.bbox);
      if (cor === "cinza") guardar(l, cor, riscada);
    }

    // pilhas: linhas da mesma cor uma embaixo da outra
    const pilhas = [];
    for (const l of linhas.sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
      const p = pilhas.find((q) => {
        const u = q[q.length - 1];
        return u.cor === l.cor && l.bbox.y0 - u.bbox.y1 < Math.max(u.h, l.h) * 1.2
          && Math.min(u.bbox.x1, l.bbox.x1) - Math.max(u.bbox.x0, l.bbox.x0) > -l.h;
      });
      if (p) p.push(l); else pilhas.push([l]);
    }

    const distRet = (a, b) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));
    const donoDa = (pilha) => {
      // nota que começa com "(P1)": é do poste com esse apelido
      const ap = /^\(P(\d{1,3})\)/.exec(pilha[0].texto);
      if (ap) return rotulos.find((r) => r.apelido === `(P${ap[1]})`) || null;
      // uma linha na mesma altura do F.P ou do "(P1)" dele, encostada: terminando logo à
      // esquerda ("DT12/1000 ... (P1) F.P2") ou começando logo à direita ("(P6) DT11/1000")
      let dono = null, folga = Infinity;
      for (const l of pilha) {
        const [, ly] = centro(l.bbox);
        for (const r of rotulos) {
          for (const a of r.ancoras) {
            // mesma faixa de altura (o rótulo às vezes fica meia linha acima da caixa)
            if (Math.abs(centro(a)[1] - ly) >= l.h * 1.2) continue;
            const esq = a.x0 - l.bbox.x1, dir = l.bbox.x0 - a.x1;
            // à direita pode ter, no meio, o texto preto do que já existe ("(P2) DT11/600 1-BI9
            // 1-RA2 1-B3 [1-B4]"): a caixa vermelha no fim da linha ainda é deste poste
            const vao = esq > -l.h && esq < l.h * 6 ? esq : dir > -l.h && dir < l.h * 14 ? dir : Infinity;
            if (vao < folga) { dono = r; folga = vao; }
          }
        }
      }
      if (dono) return dono;
      // senão, o rótulo mais perto (se estiver perto)
      const caixa = pilha.reduce((b, l) => ({ x0: Math.min(b.x0, l.bbox.x0), y0: Math.min(b.y0, l.bbox.y0), x1: Math.max(b.x1, l.bbox.x1), y1: Math.max(b.y1, l.bbox.y1) }), { ...pilha[0].bbox });
      let perto = null, dist = pilha[0].h * 3;
      for (const r of rotulos) for (const a of r.ancoras) { const d = distRet(caixa, a); if (d < dist) { perto = r; dist = d; } }
      return perto;
    };

    if (window.CROQUI_DEPURAR) window.CROQUI_DEPURAR = { nosso: nosso.texto, rotulos: rotulos.map((r) => [r.texto, r.apelido, r.ancoras.map((b) => [b.x0, b.y0, b.x1, b.y1])]), pilhas: pilhas.map((p) => [donoDa(p)?.texto || "-", p.map((l) => `${l.cor[0]} ${l.texto} @${l.bbox.x0},${l.bbox.y0}-${l.bbox.x1},${l.bbox.y1}`)]) };
    const nossas = pilhas.filter((p) => donoDa(p) === nosso)
      .sort((a, b) => (a[0].cor === "vermelho" ? 0 : 1) - (b[0].cor === "vermelho" ? 0 : 1) || a[0].bbox.y0 - b[0].bbox.y0);
    return {
      poste: nosso.texto, apelido: nosso.apelido, distancia: longeDoMeio(nosso),
      linhas: nossas.flat().map(({ texto, cor, riscada, conf }) => ({ texto, cor, riscada, conf })),
    };
  }

  // leitura na borda do recorte: um rótulo vizinho cortado pela metade ("(P1" do (P157)).
  // Mais perto que isso vale: às vezes quem acha o (P163) é um grupo verde ao lado dele
  const PERTO_DO_GRUPO = 0.4;
  /** Todos os pontos do projeto numa folha: os "(P2)" verdes. Acha os textos verdes pela cor
   *  (rápido, sem OCR), lê cada um com `lerPoste` (endireita em qualquer posição) e fica com
   *  os que são (P). `aoAndar(feitos, total)` conta o progresso.
   *  Devolve [{ nome: "P2", pag, x, y }] (x, y em fração da folha). */
  async function acharPontos(proj, pag = 1, aoAndar = () => {}) {
    const im = await imagem(proj, { pag, px: 3000, canvas: true });
    const W = im.cv.width, H = im.cv.height;
    const d = im.cv.getContext("2d").getImageData(0, 0, W, H).data;
    // grade de células de 4 px com tinta verde; células vizinhas formam um texto
    const C = 4, gw = Math.ceil(W / C), gh = Math.ceil(H / C);
    const cel = new Uint8Array(gw * gh);
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (Math.min(r, g, b) < 170 && g > r + 60 && g > b + 30) cel[((y / C) | 0) * gw + ((x / C) | 0)] = 1;
      }
    }
    // junta as letras de um mesmo texto: fecha os vãos de até 2 células
    const viz = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      if (!cel[y * gw + x]) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) viz[yy * gw + xx] = 1;
      }
    }
    const visto = new Uint8Array(gw * gh), grupos = [];
    for (let s = 0; s < viz.length; s++) {
      if (!viz[s] || visto[s]) continue;
      let x0 = gw, y0 = gh, x1 = 0, y1 = 0, n = 0;
      const pilha = [s];
      visto[s] = 1;
      while (pilha.length) {
        const k = pilha.pop(), x = k % gw, y = (k / gw) | 0;
        if (cel[k]) { n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        for (const v of [k - 1, k + 1, k - gw, k + gw]) {
          if (v < 0 || v >= viz.length || visto[v] || !viz[v]) continue;
          if ((v === k - 1 && x === 0) || (v === k + 1 && x === gw - 1)) continue;
          visto[v] = 1;
          pilha.push(v);
        }
      }
      if (!n) continue;
      // tamanho e forma de um "(P12)": baixo e comprido (em pé, se o projeto estiver girado)
      const a = (x1 - x0 + 1) * C, b = (y1 - y0 + 1) * C, curto = Math.min(a, b), longo = Math.max(a, b);
      const ref = Math.max(W, H);
      if (window.CROQUI_DEPURAR) (window.CROQUI_GRUPOS = window.CROQUI_GRUPOS || []).push({ x: ((x0 + x1 + 1) / 2) * C / W, y: ((y0 + y1 + 1) / 2) * C / H, a, b, n });
      // (encostado num símbolo verde fica quase quadrado: a leitura de perto decide)
      if (curto < ref * 0.002 || curto > ref * 0.02 || longo / curto < 1.1 || longo / curto > 8 || longo > ref * 0.05) continue;
      grupos.push({ x: ((x0 + x1 + 1) / 2) * C / W, y: ((y0 + y1 + 1) / 2) * C / H });
    }
    const achados = [];
    for (const [i, g] of grupos.entries()) {
      aoAndar(i, grupos.length);
      const r = await lerPoste(proj, { pag, x: g.x, y: g.y });
      // num círculo ou símbolo verde o OCR acaba lendo um (P) vizinho cortado na borda
      if (window.CROQUI_DEPURAR && r) (window.CROQUI_PERTO = window.CROQUI_PERTO || []).push(`${r.nome}@${g.x.toFixed(3)},${g.y.toFixed(3)} ${r.perto.toFixed(3)}`);
      if (r?.nome && r.perto <= PERTO_DO_GRUPO) achados.push({ nome: r.nome, pag, x: g.x, y: g.y, comP: r.comP });
    }
    aoAndar(grupos.length, grupos.length);
    // o mesmo nome duas vezes (o (P6) do "DETALHE A" e o da rua): fica o que está junto dos
    // outros pontos (o detalhe é um quadro à parte, longe da rede)
    const pertoDosOutros = (p) => Math.min(...achados.filter((q) => q !== p && q.nome !== p.nome).map((q) => Math.hypot(q.x - p.x, q.y - p.y)), 9);
    const unicos = new Map();
    for (const p of achados) {
      const ja = unicos.get(p.nome);
      if (!ja || pertoDosOutros(p) < pertoDosOutros(ja)) unicos.set(p.nome, p);
    }
    return corrigirNumeros([...unicos.values()]);
  }

  /** Acerta os números que o OCR leu errado comparando com os outros pontos da folha. */
  function corrigirNumeros(lista) {
    // número fora da sequência ("P35" numa folha de P1 a P8): o OCR pôs um dígito a mais na
    // frente; se tirando ele sobra um número que falta e cabe na faixa dos outros (5), é esse.
    // Projeto grande continua a numeração (P31 a P45 numa folha): aí o número fica como está
    const numeros = lista.map((p) => Number(p.nome.slice(1)));
    const usados = new Set(numeros);
    const folga = lista.length + 3;
    const ordem = [...numeros].sort((a, b) => a - b), mediana = ordem[ordem.length >> 1] || 0;
    // baixo: bem abaixo da folha e com menos algarismos (P75 entre P158 e P186) ou menos de
    // um terço do meio dela (P13 entre P81 e P106)
    const baixo = (n) => (String(n).length < String(mediana).length || n < mediana / 3) && n < mediana - folga;
    // o dígito da frente sumiu ("(P64)" lido "P4" ao lado do P61 e do P62; "(P113)" lido "P13"
    // ao lado do P105 e do P106): só quando são 1 ou 2 soltos na folha. Vários juntos (P1 a
    // P6 numa folha que também tem P27 a P30) são pontos de verdade
    let baixos = lista.filter((p) => baixo(Number(p.nome.slice(1))));
    // número de 3 algarismos: o OCR quase sempre perde o "1" colado no P ("(P117)" → "P17").
    // Dois algarismos bem abaixo da folha e o 1xx cabe na faixa dos outros: é o 1xx
    const altos = numeros.filter((n) => !baixo(n));
    if (altos.length >= 3) {
      const aLo = Math.min(...altos), aHi = Math.max(...altos);
      for (const p of baixos) {
        const n = Number(p.nome.slice(1)), c = 100 + n;
        if (p.comP !== false && n >= 10 && n < 100 && !usados.has(c) && c >= aLo - folga && c <= aHi + folga) { usados.delete(n); usados.add(c); p.nome = `P${c}`; }
      }
      baixos = lista.filter((p) => baixo(Number(p.nome.slice(1))));
    }
    const descartar = new Set();
    if (baixos.length <= 2 && baixos.length <= lista.length * 0.15) {
      for (const p of baixos) {
        const n = Number(p.nome.slice(1));
        // lido sem o "P": é um símbolo verde do desenho (círculo, texto), não um rótulo
        if (p.comP === false) { descartar.add(p); continue; }
        const viz = lista.filter((q) => !baixos.includes(q))
          .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y)).slice(0, 2)
          .map((q) => Number(q.nome.slice(1)));
        if (viz.length < 2 || Math.abs(viz[0] - viz[1]) > 10) continue; // vizinhos não concordam
        // os números a até 10 dos vizinhos que terminam ou começam com o que foi lido
        // ("P8" → 108 ao lado do P105 e do P106; "(P226)" lido "P2" → 226)
        const ref = (viz[0] + viz[1]) / 2, fim = String(n);
        const cabe = [];
        for (let c = Math.max(n + 1, Math.ceil(ref - 10)); c <= ref + 10; c++) {
          if ((String(c).endsWith(fim) || String(c).startsWith(fim)) && !usados.has(c)) cabe.push(c);
        }
        cabe.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
        if (cabe.length && Math.abs(cabe[0] - ref) <= 10) { usados.delete(n); usados.add(cabe[0]); p.nome = `P${cabe[0]}`; }
      }
    }
    for (const p of lista) {
      const n = Number(p.nome.slice(1));
      const outros = numeros.filter((x) => x !== n);
      if (outros.length < 3) continue;
      const lo = Math.min(...outros), hi = Math.max(...outros);
      if (n <= hi + folga) continue; // perto dos outros: é da sequência
      const sem = Number(String(n).slice(1));
      if (sem && !usados.has(sem) && sem >= lo - folga && sem <= hi + folga) { usados.delete(n); usados.add(sem); p.nome = `P${sem}`; }
    }
    return lista.filter((p) => !descartar.has(p));
  }

  // ------------------------------------------------------------------ vários croquis numa obra
  // Os arquivos (PDFs e fotos) viram um PDF só, uma folha atrás da outra: a troca de folha,
  // a análise e o PDF da medição valem para todos. pdf-lib pelo cdnjs (guardado pelo sw.js).
  const PDFLIB = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
  let carregandoPdfLib = null;
  function pdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    carregandoPdfLib = carregandoPdfLib || new Promise((ok, falha) => {
      const s = document.createElement("script");
      s.src = PDFLIB;
      s.onload = () => ok(window.PDFLib);
      s.onerror = () => { carregandoPdfLib = null; falha(new Error("Não deu para juntar os croquis. Abra o app uma vez com internet.")); };
      document.head.appendChild(s);
    });
    return carregandoPdfLib;
  }
  /** foto em JPEG já de pé (a orientação da câmera aplicada) */
  async function fotoEmJpeg(arquivo) {
    const img = await abrirImagem(arquivo);
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9));
    return { bytes: await blob.arrayBuffer(), w: img.width, h: img.height };
  }
  /** Junta vários croquis (PDFs e fotos) num PDF: { blob, paginas }. */
  async function juntarCroquis(arquivos) {
    const { PDFDocument } = await pdfLib();
    const saida = await PDFDocument.create();
    for (const a of arquivos) {
      const ehPdf = a.type === "application/pdf" || /\.pdf$/i.test(a.name || "");
      if (ehPdf) {
        const doc = await PDFDocument.load(await a.arrayBuffer(), { ignoreEncryption: true });
        for (const pg of await saida.copyPages(doc, doc.getPageIndices())) saida.addPage(pg);
      } else {
        // foto: uma folha do tamanho dela (até o tamanho de um A2)
        const f = await fotoEmJpeg(a);
        const img = await saida.embedJpg(f.bytes);
        const k = Math.min(1, 1684 / Math.max(f.w, f.h));
        const pg = saida.addPage([f.w * k, f.h * k]);
        pg.drawImage(img, { x: 0, y: 0, width: f.w * k, height: f.h * k });
      }
    }
    const bytes = await saida.save();
    return { blob: new Blob([bytes], { type: "application/pdf" }), paginas: saida.getPageCount() };
  }

  /** deixa tudo pronto para a 1ª leitura: os dois leitores e a inclinação da folha */
  function prepararProjeto(proj, pag = 1) {
    return Promise.all([prepararLeitura(1), prepararLeitura(2), inclinacaoDaFolha(proj, pag)]);
  }

  window.Croqui = { Visor, imagem, paginas, paraPdf, prepararLeitura, prepararProjeto, acharPontos, corrigirNumeros, juntarCroquis, lerPoste, lerProjeto, COR_COM, COR_SEM };
})();
