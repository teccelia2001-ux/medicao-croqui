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
  // celular: memória curta. Com o projeto grande (11 folhas, 11 MB), os dois leitores de OCR
  // e as imagens de 7 milhões de pixels juntos faziam o Chrome fechar o app ao abrir a obra
  const CELULAR = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.deviceMemory || 8) <= 4;
  const BASE_LADO = 4096; // limite de lado e de área da imagem base
  const BASE_AREA = CELULAR ? 4e6 : 7e6;
  const DETALHE_AREA = CELULAR ? 3e6 : 7e6;
  const IMAGEM_AREA = 7e6; // recortes e análise: o tamanho que a leitura precisa
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

  // ------------------------------------------------------------------ croqui girado
  // O giro é só da tela (e do croqui baixado): os pontos, vãos, anotações e rascunho ficam
  // guardados na posição da folha original, então girar e voltar não muda nada.
  const giroValido = (g) => ([90, 180, 270].includes(Number(g)) ? Number(g) : 0);
  /** posição na folha (fração) -> posição na folha girada `g` graus no sentido do relógio */
  function paraGirada(x, y, g) {
    return g === 90 ? [1 - y, x] : g === 180 ? [1 - x, 1 - y] : g === 270 ? [y, 1 - x] : [x, y];
  }
  /** o contrário: posição na folha girada -> posição na folha original */
  function daGirada(u, v, g) {
    return g === 90 ? [v, 1 - u] : g === 180 ? [1 - u, 1 - v] : g === 270 ? [1 - v, u] : [u, v];
  }
  /** a folha `f` girada `g` graus: mesmo jeito de desenhar, com W e H da folha girada */
  function folhaGirada(f, g) {
    g = giroValido(g);
    if (!g) return f;
    const W = g % 180 ? f.H : f.W, H = g % 180 ? f.W : f.H;
    return {
      W, H, giro: g, original: f,
      desenhar(ctx, escala, dx, dy, semTela) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        // o pixel (a, b) da folha desenhada reta vai para o lugar dele na folha girada
        const fw = f.W * escala, fh = f.H * escala;
        const m = g === 90 ? [0, 1, -1, 0, fh - dx, -dy] : g === 180 ? [-1, 0, 0, -1, fw - dx, fh - dy] : [0, -1, 1, 0, -dx, fw - dy];
        ctx.setTransform(...m);
        const t = f.desenhar(ctx, escala, 0, 0, semTela);
        return { promise: t.promise.finally(() => ctx.restore()), cancelar: t.cancelar };
      },
    };
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

  // ------------------------------------------------------------------ desenho guardado
  // O projeto desenhado na tela fica guardado no aparelho (JPEG, as 6 folhas mais recentes):
  // ao abrir de novo o croqui aparece na hora, sem o pdf.js desenhar tudo (no celular levava
  // segundos). O zoom de perto continua sendo desenhado do PDF.
  const IMAGENS_GUARDADAS = 6;
  async function imagemGuardada(k) {
    try {
      const v = window.Banco ? await Banco.ler(k, null) : null;
      return v instanceof Blob ? v : null;
    } catch (e) {
      return null;
    }
  }
  async function guardarImagem(k, cv) {
    try {
      if (!window.Banco) return;
      const blob = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.86));
      if (!blob) return;
      await Banco.gravar(k, blob);
      const lista = (await Banco.ler("croqui_imagens", [])).filter((x) => x !== k);
      lista.push(k);
      while (lista.length > IMAGENS_GUARDADAS) await Banco.gravar(lista.shift(), null);
      await Banco.gravar("croqui_imagens", lista);
    } catch (e) {
      /* sem espaço: segue sem guardar */
    }
  }
  // Foco do zoom pronto antes: a folha com o dobro da nitidez da imagem base, em pedaços de
  // 768 px (JPEG no aparelho, das 3 folhas mais recentes). O pdf.js leva o mesmo tempo para
  // desenhar um pedaço pequeno ou a folha toda (no celular, 1,5 a 3 s): com os pedaços prontos,
  // o zoom fica nítido em instantes. Além do dobro, desenha do PDF como antes.
  const LADO_LADRILHO = 768;
  const FOLHAS_COM_LADRILHOS = 3;
  const bitmapsLadrilho = new Map(); // chave -> ImageBitmap (os últimos usados)
  async function bitmapLadrilho(k) {
    if (bitmapsLadrilho.has(k)) {
      const b = bitmapsLadrilho.get(k);
      bitmapsLadrilho.delete(k);
      bitmapsLadrilho.set(k, b);
      return b;
    }
    const blob = await imagemGuardada(k);
    if (!blob || !window.createImageBitmap) return null;
    const b = await createImageBitmap(blob);
    bitmapsLadrilho.set(k, b);
    while (bitmapsLadrilho.size > (CELULAR ? 10 : 24)) {
      const [velho, bv] = bitmapsLadrilho.entries().next().value;
      bitmapsLadrilho.delete(velho);
      bv.close?.();
    }
    return b;
  }
  async function marcarFolhaComLadrilhos(prefixo, n) {
    try {
      const lista = (await Banco.ler("croqui_ladrilhos", [])).filter((x) => x.p !== prefixo);
      lista.push({ p: prefixo, n });
      while (lista.length > FOLHAS_COM_LADRILHOS) {
        const velha = lista.shift();
        for (let i = 0; i < velha.n; i++) await Banco.gravar(`${velha.p}|${i}`, null);
      }
      await Banco.gravar("croqui_ladrilhos", lista);
    } catch (e) { /* sem espaço */ }
  }

  // a tela desenhando o projeto: a leitura dos (P) espera (as duas juntas disputavam o celular)
  let desenhandoTela = 0;
  // e enquanto o supervisor mexe (arrasta, dá zoom, digita): o OCR é pesado e travava a tela
  let ultimaMexida = 0;
  for (const ev of ["pointerdown", "pointermove", "wheel", "keydown", "touchmove"]) {
    // o mouse só passando por cima (computador) não conta: só com o botão ou o dedo apertado
    document.addEventListener(ev, (e) => { if (ev !== "pointermove" || e.buttons) ultimaMexida = Date.now(); }, { passive: true, capture: true });
  }
  const esperarTela = async () => {
    while (desenhandoTela > 0 || Date.now() - ultimaMexida < 1200) await new Promise((r) => setTimeout(r, 150));
  };

  // ------------------------------------------------------------------ visor
  class Visor {
    constructor() {
      const el = document.createElement("div");
      el.className = "cq-visor";
      el.innerHTML = `<canvas class="cq-base"></canvas><canvas class="cq-detalhe" hidden></canvas>
        <svg class="cq-camada" xmlns="http://www.w3.org/2000/svg"><g></g></svg>
        <div class="cq-marcas"></div><div class="cq-alfinete" hidden></div>
        <div class="cq-msg" hidden></div>`;
      this.el = el;
      this.base = el.querySelector(".cq-base");
      this.detalhe = el.querySelector(".cq-detalhe");
      this.marcasEl = el.querySelector(".cq-marcas");
      this.alfineteEl = el.querySelector(".cq-alfinete");
      this.msgEl = el.querySelector(".cq-msg");
      this.camadaEl = el.querySelector(".cq-camada g");
      this._camada = { linhas: [], tracos: [] }; // vãos e rascunho desta folha
      this._desenho = null; // modo rascunho: (pontos [[x, y]...] em fração da folha) => {}
      this.s = 1; this.tx = 0; this.ty = 0; this.W = 0; this.H = 0;
      this.giro = 0; // por dentro tudo é na folha girada; quem usa o visor fala na folha original
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

    /** Abre o projeto na folha pedida, girada `giro` graus (0, 90, 180, 270). Mesmo projeto,
     *  mesma folha e mesmo giro: não faz nada. */
    carregar(proj, pag = 1, giro = 0) {
      const chave = chaveDe(proj);
      giro = giroValido(giro);
      if (this.chave === chave && this.pag === pag && this.giro === giro) return Promise.resolve();
      // o mesmo pedido já está em andamento (a tela foi redesenhada no meio): espera ele
      if (this._emCurso && this._emCurso.chave === chave && this._emCurso.pag === pag && this._emCurso.giro === giro) return this._emCurso.promise;
      const em = { chave, pag, giro };
      em.promise = this._carregar(proj, pag, chave, giro).finally(() => { if (this._emCurso === em) this._emCurso = null; });
      this._emCurso = em;
      return em.promise;
    }

    async _carregar(proj, pag, chave, giro = 0) {
      const pedido = (this._pedido = {});
      this._tarefaBase?.cancelar();
      if (this.chave !== chave) {
        this.base.hidden = true;
        this.detalhe.hidden = true;
      }
      this.msg("Abrindo o projeto…");
      const doc = await abrir(proj);
      pag = Math.min(Math.max(1, pag), doc.paginas);
      const f = folhaGirada(await folha(doc, pag), giro);
      if (pedido !== this._pedido) return; // pediram outro no meio do caminho
      this.doc = doc; this.f = f; this.pag = pag; this.chave = chave; this.giro = giro;
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
      desenhandoTela++;
      try {
        // já desenhado antes neste aparelho: aparece na hora
        const kImg = `croqui-img|${chave}|${pag}|${giro}|${this.base.width}x${this.base.height}`;
        const salvo = await imagemGuardada(kImg);
        if (pedido !== this._pedido) return;
        let pronto = false;
        if (salvo && window.createImageBitmap) {
          try {
            const bmp = await createImageBitmap(salvo);
            if (pedido !== this._pedido) return;
            this.base.getContext("2d").drawImage(bmp, 0, 0, this.base.width, this.base.height);
            bmp.close?.();
            pronto = true;
          } catch (e) { /* imagem estragada: desenha do PDF */ }
        }
        if (!pronto) {
          const tarefa = f.desenhar(this.base.getContext("2d"), this.sb, 0, 0);
          this._tarefaBase = tarefa;
          try {
            await tarefa.promise;
          } catch (e) {
            if (pedido !== this._pedido) return; // trocou de folha no meio
            throw e;
          }
          if (pedido !== this._pedido) return;
          setTimeout(() => { if (pedido === this._pedido) guardarImagem(kImg, this.base); }, 600);
        }
      } finally {
        desenhandoTela--;
      }
      if (this._dadosCamada) this.camada(this._dadosCamada); else this._desenharCamada();
      this._tinta = null;
      this._sNomes = null;
      this.msg("");
      this.base.hidden = false;
      this._ajustado = false;
      this._mexeu = false;
      if (this._listaMarcas) this.marcas(this._listaMarcas);
      this.ajustar();
      // onde tem desenho (para os nomes dos pontos fugirem dele): depois de o croqui aparecer
      setTimeout(() => {
        if (pedido !== this._pedido) return;
        this._tinta = mapaTinta(this.base);
        this._sNomes = null;
        this._posicionarMarcas();
      }, 30);
      // a folha com o dobro da nitidez, em pedaços, por trás (para o zoom focar na hora)
      this._lad = { sL: this.sb * 2, prefixo: `croqui-lad|${chave}|${pag}|${giro}|${Math.round(this.sb * 2000)}`, prontos: new Set(), pedido };
      setTimeout(() => this._prepararLadrilhos(this._lad).catch(() => {}), 1500);
    }

    /** desenha (uma vez por folha) e guarda os pedaços com o dobro da nitidez */
    async _prepararLadrilhos(lad) {
      const f = this.f;
      const L = Math.ceil((f.W * lad.sL) / LADO_LADRILHO), A = Math.ceil((f.H * lad.sL) / LADO_LADRILHO);
      lad.cols = L;
      lad.lins = A;
      const novos = [];
      for (let j = 0; j < A; j++) {
        for (let i = 0; i < L; i++) {
          if (lad.pedido !== this._pedido) return; // trocou de folha ou girou
          for (let tentativa = 0; tentativa < 20; tentativa++) {
          const k = `${lad.prefixo}|${j * L + i}`;
          if (await imagemGuardada(k)) { lad.prontos.add(j * L + i); continue; }
          await esperarTela(); // não disputa com o dedo nem com a tela desenhando
          if (lad.pedido !== this._pedido) return;
          const cv = document.createElement("canvas");
          cv.width = Math.min(LADO_LADRILHO, Math.ceil(f.W * lad.sL) - i * LADO_LADRILHO);
          cv.height = Math.min(LADO_LADRILHO, Math.ceil(f.H * lad.sL) - j * LADO_LADRILHO);
          const tarefa = f.desenhar(cv.getContext("2d"), lad.sL, i * LADO_LADRILHO, j * LADO_LADRILHO);
          this._tarefaLad = tarefa;
          try {
            await tarefa.promise;
          } catch (e) {
            cv.width = cv.height = 0;
            continue; // o dedo mexeu: este pedaço é desenhado de novo depois
          } finally {
            if (this._tarefaLad === tarefa) this._tarefaLad = null;
          }
          const blob = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.88));
          cv.width = cv.height = 0;
          if (!blob) return;
          await Banco.gravar(k, blob);
          lad.prontos.add(j * L + i);
          novos.push(k);
          break;
          }
        }
      }
      if (novos.length || !lad.marcada) {
        lad.marcada = true;
        await marcarFolhaComLadrilhos(lad.prefixo, L * A);
      }
    }

    /** o pedaço da tela montado com os ladrilhos prontos; false se falta algum */
    async _detalheDosLadrilhos(cv, vista, dpr) {
      const lad = this._lad;
      if (!lad?.cols || lad.pedido !== this._pedido) return false;
      const k = (vista.s * dpr) / lad.sL; // ladrilho -> tela
      if (k > 1.08) return false; // mais perto que o dobro: só o PDF dá nitidez
      const T = LADO_LADRILHO;
      // a parte da folha (em px dos ladrilhos) que aparece na tela
      const x0 = (-vista.tx / vista.s) * lad.sL, y0 = (-vista.ty / vista.s) * lad.sL;
      const x1 = x0 + (this.cw / vista.s) * lad.sL, y1 = y0 + (this.ch / vista.s) * lad.sL;
      const i0 = Math.max(0, Math.floor(x0 / T)), i1 = Math.min(lad.cols - 1, Math.floor(x1 / T));
      const j0 = Math.max(0, Math.floor(y0 / T)), j1 = Math.min(lad.lins - 1, Math.floor(y1 / T));
      const precisa = [];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) precisa.push([i, j]);
      if (!precisa.length || precisa.some(([i, j]) => !lad.prontos.has(j * lad.cols + i))) return false;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      for (const [i, j] of precisa) {
        const b = await bitmapLadrilho(`${lad.prefixo}|${j * lad.cols + i}`);
        if (!b) return false;
        ctx.drawImage(b, (i * T * k) + vista.tx * dpr, (j * T * k) + vista.ty * dpr, b.width * k, b.height * k);
      }
      return true;
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
      { const [x, y] = paraGirada(pos.x, pos.y, this.giro); pos = { x, y }; }
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
      { const [x, y] = paraGirada(pos.x, pos.y, this.giro); pos = { x, y }; }
      const x = this.tx + pos.x * this.W * this.s, y = this.ty + pos.y * this.H * this.s;
      const altura = this.ch - baixo, largura = this.cw - direita;
      if (y > altura - 36 || y < 70) this.ty += Math.max(90, altura / 2) - y;
      if (x < 30 || x > largura - 70) this.tx += largura / 2 - x;
      this._mexeu = true;
      this._aplicar();
    }

    /** O que vai desenhado por cima do projeto nesta folha (em fração da folha):
     *  linhas [{ x1, y1, x2, y2, classe }] (vãos) e tracos [{ pts: [[x, y]...], classe }] (rascunho). */
    camada(dados) {
      this._dadosCamada = dados;
      const g = this.giro, gi = (x, y) => paraGirada(x, y, g);
      this._camada = {
        linhas: (dados?.linhas || []).map((l) => {
          const [x1, y1] = gi(l.x1, l.y1), [x2, y2] = gi(l.x2, l.y2);
          return { ...l, x1, y1, x2, y2 };
        }),
        tracos: (dados?.tracos || []).map((t) => ({ ...t, pts: t.pts.map(([x, y]) => gi(x, y)) })),
      };
      this._desenharCamada();
    }
    _desenharCamada() {
      if (!this.W) return;
      const W = this.W, H = this.H, n = (v) => Math.round(v * 100) / 100;
      const pts = (lista) => lista.map(([x, y]) => `${n(x * W)},${n(y * H)}`).join(" ");
      this.camadaEl.innerHTML = this._camada.linhas.map((l) => `<line x1="${n(l.x1 * W)}" y1="${n(l.y1 * H)}" x2="${n(l.x2 * W)}" y2="${n(l.y2 * H)}" class="${esc(l.classe || "")}" vector-effect="non-scaling-stroke"/>`).join("")
        + this._camada.tracos.map((t) => `<polyline points="${pts(t.pts)}" class="cq-traco ${esc(t.classe || "")}" vector-effect="non-scaling-stroke"/>`).join("");
    }
    /** liga o modo rascunho (`aoTerminar` recebe cada traço feito com o dedo) ou desliga (null).
     *  Um dedo desenha; dois dedos continuam movendo e aproximando o croqui. */
    desenhar(aoTerminar) {
      this._desenho = aoTerminar || null;
      this.el.classList.toggle("cq-desenhando", !!aoTerminar);
    }

    /** pontos marcados nesta folha: [{ id, nome, x, y, classe }] */
    marcas(lista) {
      this._listaMarcas = lista;
      this.marcasEl.innerHTML = lista.map((m) => {
        const [x, y] = paraGirada(m.x, m.y, this.giro);
        return `<button type="button" class="cq-marca ${m.classe || ""}" data-id="${esc(m.id)}" data-x="${x}" data-y="${y}" aria-label="${esc(m.nome)}"><i></i><b class="cq-guia" hidden></b><span>${esc(m.nome)}</span></button>`;
      }).join("");
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
      if (pos) { const [x, y] = paraGirada(pos.x, pos.y, this.giro); pos = { x, y }; }
      this.pos = pos;
      this.alfineteEl.hidden = !pos;
      this._posicionarMarcas();
    }
    /** fração da folha embaixo do ponto da tela, presa na folha (para o rascunho) */
    _naFolha(cx, cy) {
      const lim = (v) => Math.max(0, Math.min(1, v));
      const [x, y] = daGirada(lim((cx - this.tx) / this.s / this.W), lim((cy - this.ty) / this.s / this.H), this.giro);
      return [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5];
    }

    /** fração da folha embaixo do ponto da tela (cx, cy); null se caiu fora da folha */
    paraFolha(cx, cy) {
      const u = (cx - this.tx) / this.s / this.W, v = (cy - this.ty) / this.s / this.H;
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      const [x, y] = daGirada(u, v, this.giro);
      return { x, y };
    }

    // ---------------------------------------------------------------- desenho
    _redimensionou() {
      const cw = this.el.clientWidth, ch = this.el.clientHeight;
      if (!cw || !ch) return; // fora da tela
      // teclado aberto (digitando o nome do ponto, a anotação...): o celular encolhe a tela, mas o
      // croqui fica parado onde estava (antes reajustava o zoom e o desenho pulava)
      const digitando = document.activeElement?.matches?.("input, textarea") && !this.el.contains(document.activeElement);
      if (digitando && this.cw && this._ajustado) return;
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
      this._tarefaLad?.cancelar(); // preparar os pedaços não pode atrasar o dedo
      clearTimeout(this._tempoDet);
      this._tempoDet = setTimeout(() => this._desenharDetalhe(), 120);
    }

    _posicionarMarcas() {
      if (!this.W) return;
      this.camadaEl.setAttribute("transform", `translate(${this.tx} ${this.ty}) scale(${this.s})`);
      // arrumar os nomes (no branco do desenho) pesa com muitos pontos: no meio do zoom ou do
      // arrasto fica para quando o dedo parar; fora do movimento, na hora
      if (this._mexendo) {
        clearTimeout(this._tempoNomes);
        this._tempoNomes = setTimeout(() => { this._mexendo = false; this._posicionarMarcas(); }, 180);
      } else this._arrumarNomes();
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
      const marca = (this._marcaDet = {});
      let tarefa = null;
      if (await this._detalheDosLadrilhos(cv, vista, dpr)) {
        if (this._marcaDet !== marca) return; // veio outro gesto no meio
      } else {
        if (this._marcaDet !== marca) return;
        tarefa = this.f.desenhar(cv.getContext("2d"), vista.s * dpr, -vista.tx * dpr, -vista.ty * dpr);
        this._tarefaDet = tarefa;
        try {
          await tarefa.promise;
        } catch (e) {
          return; // cancelado: veio outro gesto
        }
        if (this._tarefaDet !== tarefa || this._marcaDet !== marca) return;
      }
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
        this._mexendo = true;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* segue */ }
        const p = { x: e.clientX, y: e.clientY };
        dedos.set(e.pointerId, p);
        if (dedos.size === 1 && this._desenho) {
          // rascunho: o dedo desenha (o traço aparece enquanto desenha)
          toque = null;
          const r = rel(p);
          gesto = { tipo: "traco", pts: [this._naFolha(r.x, r.y)], ult: p };
          this._vivo = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
          this._vivo.setAttribute("class", "cq-traco cq-traco-vivo");
          this._vivo.setAttribute("vector-effect", "non-scaling-stroke");
          this.camadaEl.appendChild(this._vivo);
        } else if (dedos.size === 1) {
          toque = { ...p, t: Date.now(), alvo: e.target.closest(".cq-marca") };
          gesto = comecarArrasto(p);
        } else if (dedos.size === 2) {
          toque = null;
          if (gesto?.tipo === "traco") { this._vivo?.remove(); this._vivo = null; } // dois dedos: era para mover
          const [a, b] = [...dedos.values()];
          gesto = { tipo: "pinca", d0: dist(a, b) || 1, m0: meio(a, b), s0: this.s, tx0: this.tx, ty0: this.ty };
        }
      });
      el.addEventListener("pointermove", (e) => {
        if (!dedos.has(e.pointerId)) return;
        const p = { x: e.clientX, y: e.clientY };
        dedos.set(e.pointerId, p);
        if (gesto?.tipo === "traco" && dedos.size === 1) {
          if (Math.hypot(p.x - gesto.ult.x, p.y - gesto.ult.y) < 3) return;
          gesto.ult = p;
          const r = rel(p);
          gesto.pts.push(this._naFolha(r.x, r.y));
          this._vivo?.setAttribute("points", gesto.pts.map(([x, y]) => { const [u, v] = paraGirada(x, y, this.giro); return `${u * this.W},${v * this.H}`; }).join(" "));
        } else if (gesto?.tipo === "arrasto" && dedos.size === 1) {
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
        if (gesto?.tipo === "traco" && !dedos.size) {
          const pts = gesto.pts;
          gesto = null;
          toque = null;
          this._vivo?.remove();
          this._vivo = null;
          if (pts.length >= 2 && e.type === "pointerup") this._desenho?.(pts);
          return;
        }
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
        this._mexendo = true;
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
  async function imagem(proj, { pag = 1, marcas = [], recorte = null, px = 2400, canvas = false, giro = 0 } = {}) {
    const doc = await abrir(proj);
    giro = giroValido(giro);
    const f = folhaGirada(await folha(doc, Math.min(Math.max(1, pag), doc.paginas)), giro);
    if (giro) {
      marcas = marcas.map((m) => { const [x, y] = paraGirada(m.x, m.y, giro); return { ...m, x, y }; });
      if (recorte) { const [x, y] = paraGirada(recorte.x, recorte.y, giro); recorte = { ...recorte, x, y }; }
    }
    let escala, dx = 0, dy = 0, w, h;
    if (recorte) {
      const lw = recorte.largura * f.W;
      w = px;
      h = Math.round(px / recorte.proporcao);
      escala = w / lw;
      dx = recorte.x * f.W * escala - w / 2;
      dy = recorte.y * f.H * escala - h / 2;
    } else {
      escala = Math.min(px / Math.max(f.W, f.H), Math.sqrt(IMAGEM_AREA / (f.W * f.H)));
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
  async function paraPdf(obra, proj, { recortes = true, soPag = null } = {}) {
    const pontos = (obra.pontos || []).filter((p) => !p.geral && p.croqui && (!soPag || (p.croqui.pag || 1) === soPag));
    const total = await paginas(proj);
    // medição de uma folha só: só ela; da obra inteira: as folhas com ponto (a 1ª sempre)
    const pags = soPag ? [soPag].filter((n) => n <= total) : [...new Set([1, ...pontos.map((p) => p.croqui.pag || 1)])].filter((n) => n <= total).sort((a, b) => a - b);
    const marcasDa = (pag, destaque) => pontos.filter((p) => (p.croqui.pag || 1) === pag).map((p) => ({
      nome: p.nome, x: p.croqui.x, y: p.croqui.y,
      cor: p === destaque ? COR_DESTAQUE : p.itens.length ? COR_COM : COR_SEM, destaque: p === destaque,
    }));
    const geral = [];
    const giroDe = (pag) => giroValido(obra.projeto?.giros?.[pag]);
    for (const pag of pags) geral.push({ pag, total, ...(await imagem(proj, { pag, marcas: marcasDa(pag), giro: giroDe(pag) })) });
    const porPonto = new Map();
    if (recortes) {
      for (const p of pontos) {
        const pag = p.croqui.pag || 1;
        porPonto.set(p.id, {
          pag,
          ...(await imagem(proj, {
            pag, marcas: marcasDa(pag, p), px: 1500, giro: giroDe(pag),
            recorte: { x: p.croqui.x, y: p.croqui.y, largura: 0.42, proporcao: PROPORCAO_RECORTE },
          })),
        });
      }
    }
    return { geral, porPonto };
  }

  // ------------------------------------------------------------------ símbolo do poste
  /** Símbolos de poste em volta de `pos` ({ pag, x, y }, fração da folha): os quadradinhos
   *  pretos cheios (no meio do círculo vermelho). Recorte de `largura` (fração da largura da
   *  folha). Devolve [{ x, y }] em fração da folha e `k` = altura/largura da folha. */
  async function postesPerto(proj, pos, largura = 0.44, px = 2000) {
    const pag = pos.pag || 1;
    const doc = await abrir(proj);
    const f = await folha(doc, Math.min(Math.max(1, pag), doc.paginas));
    const { cv, w, h } = await imagem(proj, { pag, px, canvas: true, recorte: { x: pos.x, y: pos.y, largura, proporcao: 1 } });
    const d = cv.getContext("2d").getImageData(0, 0, w, h).data;
    cv.width = cv.height = 0;
    const N = w * h, preto = new Uint8Array(N);
    for (let k = 0, i = 0; k < N; k++, i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      if (mx < 110 && mx - Math.min(d[i], d[i + 1], d[i + 2]) < 50) preto[k] = 1;
    }
    const escala = w / (largura * f.W); // px do recorte por ponto da folha
    const visto = new Uint8Array(N), pilha = [], achados = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (!preto[s0] || visto[s0]) continue;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0, quente = 0;
      visto[s0] = 1;
      pilha.push(s0);
      while (pilha.length) {
        const k = pilha.pop(), x = k % w, y = (k / w) | 0;
        n++;
        quente += d[k * 4] - d[k * 4 + 1]; // marrom: mais vermelho que verde (o fundo oliva e o preto, não)
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && preto[k - 1] && !visto[k - 1]) { visto[k - 1] = 1; pilha.push(k - 1); }
        if (x < w - 1 && preto[k + 1] && !visto[k + 1]) { visto[k + 1] = 1; pilha.push(k + 1); }
        if (y > 0 && preto[k - w] && !visto[k - w]) { visto[k - w] = 1; pilha.push(k - w); }
        if (y < h - 1 && preto[k + w] && !visto[k + w]) { visto[k + w] = 1; pilha.push(k + w); }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, lado = Math.max(bw, bh) / escala; // lado em pontos
      // quadrado cheio de 2 a 20 pontos (as letras pretas são finas: enchem pouco a caixa)
      const cheio = !(Math.max(bw, bh) < 7 || lado < 1.5 || lado > 20 || bw / bh < 0.5 || bw / bh > 2 || n / (bw * bh) < 0.55);
      // poste existente: caixinha vazada (□ ou □□, só o contorno preto), de 3 a 20 pontos. As
      // letras redondas (O, D, 0) não fecham os quatro lados retos da caixa
      let vazado = false;
      if (!cheio && Math.max(bw, bh) >= 9 && lado >= 3 && lado <= 20 && bw / bh >= 0.4 && bw / bh <= 2.6 && n / (bw * bh) < 0.6) {
        const escuro = (x, y) => preto[y * w + x] === 1;
        const lin = (y, y2) => { let c = 0; for (let x = x0; x <= x1; x++) if (escuro(x, y) || escuro(x, y2)) c++; return c / bw; };
        const col = (x, x2) => { let c = 0; for (let y = y0; y <= y1; y++) if (escuro(x, y) || escuro(x2, y)) c++; return c / bh; };
        vazado = lin(y0, Math.min(y1, y0 + 1)) > 0.8 && lin(y1, Math.max(y0, y1 - 1)) > 0.8 && col(x0, Math.min(x1, x0 + 1)) > 0.8 && col(x1, Math.max(x0, x1 - 1)) > 0.8;
      }
      if (!cheio && !vazado) continue;
      // tronco de árvore: marrom bem escuro (o poste é preto neutro)
      if (quente / n > 8) continue;
      // tronco de árvore (escuro e cheio como o poste): tem a copa verde em volta. Fica de fora
      {
        const m = Math.max(bw, bh) * 2;
        const ax = Math.max(0, Math.floor(x0 - m)), bx = Math.min(w - 1, Math.ceil(x1 + m));
        const ay = Math.max(0, Math.floor(y0 - m * 1.6)), by = Math.min(h - 1, Math.ceil(y1 + m * 0.5));
        let verde = 0, total = 0;
        for (let yy = ay; yy <= by; yy += 2) {
          for (let xx = ax; xx <= bx; xx += 2) {
            const i = (yy * w + xx) * 4;
            total++;
            if (d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 30 && d[i + 1] > 70) verde++;
          }
        }
        if (total && verde / total > 0.2) continue;
      }
      const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
      achados.push({
        x: Math.round((pos.x + (cx - w / 2) / escala / f.W) * 1e5) / 1e5,
        y: Math.round((pos.y + (cy - h / 2) / escala / f.H) * 1e5) / 1e5,
        ...(vazado ? { vazado: true } : {}),
      });
    }
    return { postes: achados, k: f.H / f.W };
  }
  /** o símbolo de poste mais perto de `pos` (para o toque "grudar" no poste), ou null */
  async function acharPosteSimbolo(proj, pos, largura = 0.06) {
    const { postes, k } = await postesPerto(proj, pos, largura, 900);
    let melhor = null;
    for (const q of postes) {
      const d = Math.hypot(q.x - pos.x, (q.y - pos.y) * k);
      if (!melhor || d < melhor.d) melhor = { ...q, d };
    }
    return melhor && { x: melhor.x, y: melhor.y };
  }
  /** Linha do vão entre os postes dos rótulos `a` e `b` ({ pag, x, y } do (P) de cada um):
   *  [[x, y], [x, y]] de quadradinho a quadradinho, ou null. Cada poste perto do seu (P) e,
   *  entre os pares, o que tem a reta entre os dois por cima da rede vermelha tracejada (o
   *  poste fica em lugares diferentes em volta do (P): à esquerda, depois da caixa de texto,
   *  acima...). */
  async function linhaDoVao(proj, a, b) {
    const [pa, pb] = [await postesPerto(proj, a), await postesPerto(proj, b)];
    if (!pa.postes.length || !pb.postes.length) return null;
    const k = pa.k;
    // a folha inteira, para ver onde a reta passa por cima de vermelho
    const { cv, w, h } = await imagem(proj, { pag: a.pag || 1, px: 2400, canvas: true });
    const d = cv.getContext("2d").getImageData(0, 0, w, h).data;
    cv.width = cv.height = 0;
    const raio = Math.max(2, Math.round(w / 700));
    const vermelho = (x, y) => {
      const cx = Math.round(x * w), cy = Math.round(y * h);
      for (let yy = cy - raio; yy <= cy + raio; yy++) {
        if (yy < 0 || yy >= h) continue;
        for (let xx = cx - raio; xx <= cx + raio; xx++) {
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 4;
          if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110) return true;
        }
      }
      return false;
    };
    // quanto da reta (tirando as pontas, onde fica o símbolo) cai em cima de vermelho
    const naRede = (p, q) => {
      let n = 0;
      for (let t = 0.15; t <= 0.851; t += 0.035) if (vermelho(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t)) n++;
      return n / 21;
    };
    const longe = (q, r) => Math.hypot(q.x - r.x, (q.y - r.y) * k);
    const entreRotulos = longe(a, b);
    let melhor = null;
    for (const sa of pa.postes) {
      for (const sb of pb.postes) {
        // o mesmo símbolo, ou um vão bem mais curto que a distância entre os (P): não é este
        if (longe(sa, sb) < Math.max(0.003, entreRotulos * 0.35)) continue;
        const rede = naRede(sa, sb);
        const custo = longe(sa, a) + longe(sb, b) + 0.15 * (1 - rede);
        if (!melhor || custo < melhor.custo) melhor = { custo, rede, l: [[sa.x, sa.y], [sb.x, sb.y]] };
      }
    }
    // só com certeza: a reta corre por cima da rede vermelha (senão o supervisor ajusta)
    return melhor && melhor.rede >= 0.5 ? melhor.l : null;
  }

  // ------------------------------------------------------------------ croqui anotado (PDF)
  const AZUL = "#1d4ed8"; // anotações e rascunho do campo

  /** quebra o texto em linhas de até `largura` px na fonte atual do ctx */
  function quebrarTexto(ctx, texto, largura) {
    const linhas = [];
    for (const par of String(texto || "").split(/\n/)) {
      let atual = "";
      for (const palavra of par.split(/\s+/).filter(Boolean)) {
        const tenta = atual ? `${atual} ${palavra}` : palavra;
        if (ctx.measureText(tenta).width <= largura || !atual) atual = tenta;
        else { linhas.push(atual); atual = palavra; }
      }
      if (atual) linhas.push(atual);
    }
    return linhas.length ? linhas : [""];
  }
  /** seta saindo de (x1, y1) com a ponta em (x2, y2) */
  function seta(ctx, x1, y1, x2, y2, cor, larg) {
    const ang = Math.atan2(y2 - y1, x2 - x1), p = larg * 4.5;
    ctx.lineCap = "round";
    for (const [c, l] of [["#fff", larg + 4], [cor, larg]]) {
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.lineWidth = l;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2 - Math.cos(ang) * p * 0.6, y2 - Math.sin(ang) * p * 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - p * Math.cos(ang - 0.42), y2 - p * Math.sin(ang - 0.42));
      ctx.lineTo(x2 - p * Math.cos(ang + 0.42), y2 - p * Math.sin(ang + 0.42));
      ctx.closePath();
      if (c === "#fff") ctx.stroke(); else ctx.fill();
    }
  }
  /** lugar da caixa da anotação (w x h) perto de (px, py): no branco do projeto, sem cobrir
   *  outra anotação nem sair da folha; o mais perto possível do ponto */
  function lugarDaNota(tinta, ocupados, W, H, px, py, w, h, r) {
    const f2 = tinta.f * tinta.f, area = (w * h) / f2;
    let melhor = null;
    for (const d of [2.5, 4, 6, 9, 13, 18, 25, 34, 45].map((k) => k * r)) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const cx = px + Math.cos(a) * (d + w / 2), cy = py + Math.sin(a) * (d + h / 2);
        const ret = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
        const c = (tintaEm(tinta, ret) / area) * 100 + ((sobreposicao(ret, ocupados) + foraDa(ret, W, H)) / (w * h)) * 400 + (d / r) * 0.6;
        if (!melhor || c < melhor.c) melhor = { ...ret, c };
      }
    }
    return melhor;
  }
  const caixa = (ctx, x, y, w, h, raio) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, raio);
    else ctx.rect(x, y, w, h);
  };
  /** Croqui da obra em PDF, uma página por folha do projeto, com os pontos (P), os vãos, o
   *  rascunho e as anotações em azul no branco do projeto, com seta até o lugar marcado.
   *  folhas: [{ pag, marcas: [{ nome, x, y, cor }], vaos: [{ x, y, texto }],
   *  tracos: [[[x, y]...]], notas: [{ x, y, texto }] }] (x, y em fração da folha). */
  async function croquiAnotado(proj, folhas, { titulo = "", aoAndar = () => {} } = {}) {
    if (!window.jspdf?.jsPDF) throw new Error("A biblioteca do PDF não carregou. Abra o app com internet uma vez.");
    const { jsPDF } = window.jspdf;
    let pdf = null;
    for (let [i, fl] of folhas.entries()) {
      aoAndar(i, folhas.length);
      // folha girada como na tela: as posições guardadas (folha original) vão para a girada
      const g = giroValido(fl.giro), gi = (x, y) => paraGirada(x, y, g);
      const { cv, w, h } = await imagem(proj, { pag: fl.pag, marcas: fl.marcas || [], px: CELULAR ? 2400 : 3000, canvas: true, giro: g });
      fl = {
        ...fl,
        tracos: (fl.tracos || []).map((t) => t.map(([x, y]) => gi(x, y))),
        vaos: (fl.vaos || []).map((v) => { const [x, y] = gi(v.x, v.y); return { ...v, x, y, linha: v.linha && v.linha.map(([a, b]) => gi(a, b)) }; }),
        notas: (fl.notas || []).map((n) => { const [x, y] = gi(n.x, n.y); return { ...n, x, y }; }),
      };
      const ctx = cv.getContext("2d");
      const r = Math.max(6, Math.round(Math.max(w, h) / 130));
      // rascunho do campo (alteração da rede)
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const t of fl.tracos || []) {
        if (t.length < 2) continue;
        for (const [cor, l] of [["#fff", r * 0.5 + 3], [AZUL, r * 0.5]]) {
          ctx.strokeStyle = cor;
          ctx.lineWidth = l;
          ctx.beginPath();
          t.forEach(([x, y], k) => (k ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
          ctx.stroke();
        }
      }
      // vãos: a linha de um poste ao outro (por cima da rede) e a metragem no meio
      ctx.setLineDash([r * 0.9, r * 0.6]);
      for (const v of fl.vaos || []) {
        if (!v.linha) continue;
        const [[ax, ay], [bx, by]] = v.linha;
        for (const [cor, l] of [["#fff", r * 0.45 + 3], ["#7c3aed", r * 0.45]]) {
          ctx.strokeStyle = cor;
          ctx.lineWidth = l;
          ctx.beginPath();
          ctx.moveTo(ax * w, ay * h);
          ctx.lineTo(bx * w, by * h);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.font = `700 ${Math.round(r * 1.5)}px Helvetica, Arial, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const ocupados = [];
      for (const v of fl.vaos || []) {
        const tw = ctx.measureText(v.texto).width + r * 1.2, th = r * 2.1, x = v.x * w, y = v.y * h;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#7c3aed";
        ctx.lineWidth = Math.max(2, r * 0.18);
        caixa(ctx, x - tw / 2, y - th / 2, tw, th, th / 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#6d28d9";
        ctx.fillText(v.texto, x, y);
        ocupados.push({ x0: x - tw / 2, y0: y - th / 2, x1: x + tw / 2, y1: y + th / 2 });
      }
      ctx.textAlign = "left";
      // anotações: caixa no branco do projeto e seta até o lugar marcado
      if ((fl.notas || []).length) {
        const tinta = mapaTinta(cv, 3);
        const fonte = Math.round(r * 1.45), linhaH = fonte * 1.22, pad = r * 0.6;
        ctx.font = `600 ${fonte}px Helvetica, Arial, sans-serif`;
        for (const n of fl.notas) {
          const linhas = quebrarTexto(ctx, n.texto, w * 0.26);
          const bw = Math.max(...linhas.map((l) => ctx.measureText(l).width)) + pad * 2, bh = linhas.length * linhaH + pad * 2;
          const px = n.x * w, py = n.y * h;
          const lugar = lugarDaNota(tinta, ocupados, w, h, px, py, bw, bh, r);
          ocupados.push(lugar);
          // a seta sai da borda da caixa mais perto do ponto
          const sx = Math.max(lugar.x0, Math.min(px, lugar.x1)), sy = Math.max(lugar.y0, Math.min(py, lugar.y1));
          seta(ctx, sx, sy, px, py, AZUL, Math.max(2, r * 0.2));
          ctx.fillStyle = "rgba(255, 255, 255, 0.93)";
          ctx.strokeStyle = AZUL;
          ctx.lineWidth = Math.max(2, r * 0.16);
          caixa(ctx, lugar.x0, lugar.y0, bw, bh, r * 0.5);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = AZUL;
          ctx.textBaseline = "top";
          linhas.forEach((l, k) => ctx.fillText(l, lugar.x0 + pad, lugar.y0 + pad + k * linhaH + (linhaH - fonte) / 2));
        }
      }
      if (titulo) {
        ctx.font = `700 ${Math.round(r * 1.3)}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = "top";
        const t = `${titulo}${folhas.length > 1 ? ` · folha ${fl.pag}` : ""}`;
        const tw = ctx.measureText(t).width;
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        ctx.fillRect(r * 0.6, r * 0.6, tw + r, r * 2);
        ctx.fillStyle = "#0f172a";
        ctx.fillText(t, r * 1.1, r * 0.95);
      }
      const k = 0.5, pw = w * k, ph = h * k, orient = w > h ? "landscape" : "portrait";
      const url = cv.toDataURL("image/jpeg", 0.88);
      cv.width = cv.height = 0; // solta a memória antes da próxima folha
      if (!pdf) pdf = new jsPDF({ unit: "pt", format: [pw, ph], orientation: orient });
      else pdf.addPage([pw, ph], orient);
      pdf.addImage(url, "JPEG", 0, 0, pw, ph);
    }
    aoAndar(folhas.length, folhas.length);
    return pdf.output("blob");
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
    if (CELULAR) n = 1; // um leitor só no celular (cada um ocupa dezenas de MB)
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
  // ângulo em que o último (P) desta folha ficou de pé: os rótulos de uma folha costumam
  // estar todos no mesmo sentido, então o próximo toque tenta esse primeiro (bem mais rápido)
  const angulosQueDeram = new Map();
  function lerPoste(proj, pos) {
    return naFila(async () => {
      // lê em tamanhos diferentes e fica com o nome que mais se repete: o OCR às vezes troca
      // um número num deles ("(P5)" lido "(P3)"). Os ângulos são medidos uma vez só por toque.
      const votos = new Map(), ctx = { k: `${chaveDe(proj)}|${pos.pag || 1}`, angulos: null };
      for (const px of window.CROQUI_TAMANHOS || [700, 900, 1150]) {
        const achou = await lerPosteEm(proj, pos, px, ctx);
        if (!achou) continue;
        const v = votos.get(achou.nome) || { ...achou, n: 0 };
        v.n++;
        v.comP = v.comP || achou.comP;
        v.perto = Math.min(v.perto ?? 1, achou.perto ?? 1);
        if (!v.todas?.length) v.todas = achou.todas || [];
        votos.set(achou.nome, v);
        if (v.n >= 2) break; // dois iguais: decidido
      }
      const melhor = [...votos.values()].sort((a, b) => b.n - a.n)[0];
      // comP: o "P" apareceu na leitura (sem ele pode ser um símbolo verde do desenho)
      // perto: distância do rótulo lido ao toque (fração do recorte)
      return melhor ? { nome: melhor.nome, texto: melhor.texto, comP: !!melhor.comP, perto: melhor.perto ?? 1, todas: melhor.todas || [] } : null;
    });
  }

  // uma leitura de cada vez: a releitura da quantidade muda o modo do leitor por um instante
  let filaOcr = Promise.resolve();
  function naFila(fn) {
    const vez = filaOcr.then(fn, fn);
    filaOcr = vez.catch(() => {});
    return vez;
  }
  async function lerPosteEm(proj, pos, px, ctx = {}) {
    const w = await prepararLeitura();
    const LARGURA = 0.12;
    const im = await imagem(proj, { pag: pos.pag || 1, px, canvas: true, recorte: { x: pos.x, y: pos.y, largura: LARGURA, proporcao: 2 } });
    const doc = await abrir(proj);
    const f = await folha(doc, Math.min(Math.max(1, pos.pag || 1), doc.paginas));
    const escala = im.cv.width / (LARGURA * f.W); // px do recorte por ponto da folha
    /** (P) lido no recorte girado `ang` -> lugar na folha; null se ficou cortado na borda */
    const naFolha = (t, ang, rw, rh) => {
      const th = (ang * Math.PI) / 180, qx = t.cx - rw / 2, qy = t.cy - rh / 2;
      const ox = qx * Math.cos(th) - qy * Math.sin(th), oy = qx * Math.sin(th) + qy * Math.cos(th);
      const m = Math.max(t.tw, t.th) / 2 + 4;
      if (Math.abs(ox) > im.cv.width / 2 - m || Math.abs(oy) > im.cv.height / 2 - m) return null;
      return { nome: t.nome, x: pos.x + ox / escala / f.W, y: pos.y + oy / escala / f.H };
    };
    // projeto torto, em pé ou de cabeça para baixo: endireita e tenta cada ângulo até achar.
    // Vale de cara só a leitura com o "P" na frente do número: de cabeça para baixo o
    // "(P68)" vira "(89d)" e, sem o P, saía "P89" (o 6 vira 9 e a ordem inverte)
    let reserva = null;
    const tentados = [];
    const tenta = async (ang) => {
      tentados.push(ang);
      const achou = await lerPosteGirado(w, ang ? girar(im.cv, ang) : im.cv);
      if (achou?.comP) {
        if (ctx.k) angulosQueDeram.set(ctx.k, ang);
        const todas = (achou.todas || []).map((t) => naFolha(t, ang, achou.w, achou.h)).filter(Boolean);
        return { nome: achou.nome, texto: achou.texto, comP: true, perto: achou.perto, todas };
      }
      if (achou?.nome && !achou.virado && !reserva) reserva = { nome: achou.nome, texto: achou.texto, comP: false, perto: achou.perto };
      return null;
    };
    // 1º o ângulo que deu certo no último toque desta folha (nem mede a inclinação)
    const lembrado = ctx.k ? angulosQueDeram.get(ctx.k) : undefined;
    if (lembrado !== undefined) {
      const r = await tenta(lembrado);
      if (r) return r;
    }
    if (!ctx.angulos) ctx.angulos = await angulosDe(proj, pos.pag || 1, im.cv);
    for (const ang of ctx.angulos) {
      if (tentados.some((a) => Math.abs(a - ang) < 0.75)) continue;
      const r = await tenta(ang);
      if (r) return r;
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
    const todas = []; // todos os (P) com P lidos aqui (com vários juntos, cada um no seu lugar)
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
            if (comP) todas.push({ nome: "P" + Number(num), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, tw: x1 - x0, th: y1 - y0 });
            // o com P na frente vale mais que um sem P mais perto do toque
            if (!melhor || (comP && !melhor.comP) || (comP === melhor.comP && d < melhor.d)) {
              melhor = { nome: "P" + Number(num), texto: `(P${Number(num)})`, d, comP };
            }
          }
        }
      }
    }
    return melhor ? { nome: melhor.nome, texto: melhor.texto, comP: melhor.comP, virado, perto: melhor.d / Math.max(im.w, im.h), todas, w: im.w, h: im.h } : virado ? { virado: true } : null;
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

  /** Ângulo em que o "(P69)" verde do ponto fica de pé (o P lido como P, não como "d"), ou
   *  null. É a bússola da leitura dos serviços: o texto em volta está no mesmo sentido. */
  async function orientacaoDoRotulo(w, proj, pos) {
    const im = await imagem(proj, { pag: pos.pag || 1, px: 900, canvas: true, recorte: { x: pos.x, y: pos.y, largura: 0.12, proporcao: 2 } });
    for (const ang of await angulosDe(proj, pos.pag || 1, im.cv)) {
      const achou = await lerPosteGirado(w, ang ? girar(im.cv, ang) : im.cv);
      if (achou?.comP && achou.perto < 0.25) return ang;
    }
    return null;
  }
  const difAngulo = (a, b) => { const d = Math.abs((((a - b) % 360) + 540) % 360 - 180); return d; };

  /** lê os serviços num recorte quadrado (`largura` em fração da folha) em volta do ponto */
  async function lerRecorte(w, proj, pos, nome, largura, deRotulo) {
    // recorte quadrado: com o projeto em pé (90°) o texto corre na vertical e precisa da
    // mesma folga para cima e para baixo que teria para os lados
    let t0 = performance.now();
    const im = await imagem(proj, { pag: pos.pag || 1, px: 1700, canvas: true, recorte: { x: pos.x, y: pos.y, largura, proporcao: 1 } });
    marcarTempo(`recorte ${largura}`, t0);
    // texto torto: lê também com o recorte endireitado (girado em volta do meio, que é o
    // ponto tocado). Pode ter caixa reta e torta juntas: fica a leitura que achou mais
    // texto deste poste.
    t0 = performance.now();
    let angulos = window.CROQUI_ANGULOS || (await angulosDe(proj, pos.pag || 1, im.cv)); // (CROQUI_ANGULOS: só para teste)
    if (deRotulo != null) {
      const doMesmoLado = angulos.filter((a) => difAngulo(a, deRotulo) < 45 && Math.abs(a - deRotulo) > 0.75);
      angulos = [deRotulo, ...doMesmoLado];
    }
    marcarTempo("inclinação", t0);
    if (window.CROQUI_DEPURAR) window.CROQUI_ANG = angulos;
    let melhor = null;
    for (const a of angulos) {
      t0 = performance.now();
      const r = await analisar(w, a ? girar(im.cv, a) : im.cv, nome);
      marcarTempo(`leitura a ${a}°`, t0);
      // vale pelo que dá para reconhecer do projeto (DT11/1000, 1-CE3, 3-100A, ATERRAMENTO,
      // INST...): de cabeça para baixo ou picado ("ATERRAME" + "NTO") quase não pontua. A
      // confiança do OCR sozinha engana (dá 92 para um pedaço e 37 para a palavra certa).
      const nota = r ? r.linhas.reduce((s, l) => s + pontosDoTexto(l.texto), 0) - (r.distancia / (im.w * 0.05)) * 3 : -Infinity;
      const conf = r?.linhas.length ? r.linhas.reduce((s, l) => s + l.conf, 0) / r.linhas.length : 0;
      if (window.CROQUI_DEPURAR) (window.CROQUI_NOTAS = window.CROQUI_NOTAS || []).push({ largura, a, nota: Math.round(nota), conf: Math.round(conf), dist: r && Math.round(r.distancia), linhas: r && r.linhas.map((l) => `${l.texto} (${Math.round(l.conf)})`) });
      if (!melhor || nota > melhor.nota) melhor = { r, nota };
      // leitura que reconhece bastante do projeto, no ponto: basta (não lê nos outros ângulos)
      if (r?.linhas.length && r.distancia < im.w * 0.1 && nota >= 25) break;
      // os de cabeça para baixo (+180°) vêm no fim da lista: só se nenhuma leitura prestou
      if (Math.abs(a) > 90 && melhor.nota >= 12) break;
      const proximo = angulos[angulos.indexOf(a) + 1];
      if (proximo !== undefined && Math.abs(proximo) > 90 && melhor.nota >= 12) break;
    }
    return melhor;
  }

  async function lerProjetoAgora(proj, pos, nome) {
    let t0 = performance.now();
    const w = await prepararLeitura();
    marcarTempo("leitor", t0);
    // o rótulo (P) diz qual lado é para cima: lê nesse sentido e não tenta o de cabeça para
    // baixo (o (P69) em pé saía "VAIAYHNIT" = LINHA VIVA invertido)
    t0 = performance.now();
    const deRotulo = window.CROQUI_ANGULOS ? null : await orientacaoDoRotulo(w, proj, pos).catch(() => null);
    marcarTempo("rótulo", t0);
    // recorte de 30% da folha; texto miúdo (projeto grande numa folha só) sai embaralhado
    // nele ("3772/1500" no lugar de "DT12/1500"): se reconheceu pouco, lê de novo com zoom
    let melhor = await lerRecorte(w, proj, pos, nome, window.CROQUI_LARGURA || 0.3, deRotulo);
    if (!window.CROQUI_LARGURA && melhor.nota < 25) {
      const perto = await lerRecorte(w, proj, pos, nome, 0.15, deRotulo);
      if (perto.nota > melhor.nota) melhor = perto;
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
    // celular: um leitor só, uma passada depois da outra
    const [linhasTudo, linhasVerm] = w2 === w
      ? [await linhasDe(w, tudo.cv), await linhasDe(w, verm.cv)]
      : await Promise.all([linhasDe(w, tudo.cv), linhasDe(w2, verm.cv)]);
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
  async function acharPontos(proj, pag = 1, aoAndar = () => {}, { inicio = 0, parciais = [], aoGuardar = null } = {}) {
    const im = await imagem(proj, { pag, px: 3000, canvas: true });
    const W = im.cv.width, H = im.cv.height;
    // grade de células de 4 px com tinta verde; células vizinhas formam um texto.
    // Lê a folha em faixas e solta a imagem logo: inteira ocupava ~90 MB (pesa no celular)
    const C = 4, gw = Math.ceil(W / C), gh = Math.ceil(H / C);
    const cel = new Uint8Array(gw * gh);
    const ctxF = im.cv.getContext("2d");
    for (let y0 = 0; y0 < H; y0 += 256) {
      const fh = Math.min(256, H - y0);
      const d = ctxF.getImageData(0, y0, W, fh).data;
      for (let y = 0, i = 0; y < fh; y++) {
        for (let x = 0; x < W; x++, i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (Math.min(r, g, b) < 170 && g > r + 60 && g > b + 30) cel[(((y0 + y) / C) | 0) * gw + ((x / C) | 0)] = 1;
        }
      }
    }
    im.cv.width = im.cv.height = 0;
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
    // continuando uma busca interrompida (a tela recarregou): os grupos já lidos não voltam
    const achados = [...parciais];
    for (const [i, g] of grupos.entries()) {
      if (i < inicio) continue;
      await esperarTela();
      aoAndar(i, grupos.length);
      const r = await lerPoste(proj, { pag, x: g.x, y: g.y });
      // num círculo ou símbolo verde o OCR acaba lendo um (P) vizinho cortado na borda
      if (window.CROQUI_DEPURAR && r) (window.CROQUI_PERTO = window.CROQUI_PERTO || []).push(`${r.nome}@${g.x.toFixed(3)},${g.y.toFixed(3)} ${r.perto.toFixed(3)}`);
      if (r?.nome && r.perto <= PERTO_DO_GRUPO) achados.push({ nome: r.nome, pag, x: g.x, y: g.y, comP: r.comP, perto: r.perto });
      // com vários (P) juntos, um grupo verde pode cobrir mais de um rótulo (P14 a P19): os outros
      // inteiros da mesma leitura entram também, no lugar de cada um no desenho
      for (const t of r?.todas || []) {
        if (t.nome !== r.nome) achados.push({ nome: t.nome, pag, x: t.x, y: t.y, comP: true, perto: 0.03 });
      }
      // a cada grupo: guarda até onde foi (no celular a página pode ser fechada) e o (P) lido
      if (aoGuardar) await aoGuardar(i + 1, achados);
    }
    aoAndar(grupos.length, grupos.length);
    // o mesmo nome duas vezes (o (P6) do "DETALHE A" e o da rua): fica o que está junto dos
    // outros pontos (o detalhe é um quadro à parte, longe da rede)
    const pertoDosOutros = (p) => Math.min(...achados.filter((q) => q !== p && q.nome !== p.nome).map((q) => Math.hypot(q.x - p.x, q.y - p.y)), 9);
    // e o mesmo nome lido por um grupo verde vizinho (a árvore verde ao lado do "(P20)"): fica o
    // grupo em que o rótulo estava no centro da leitura, que é o próprio rótulo
    const centro = (p) => p.perto ?? 0;
    const unicos = new Map();
    for (const p of achados) {
      const ja = unicos.get(p.nome);
      const melhor = !ja || (Math.abs(centro(p) - centro(ja)) > 0.05 ? centro(p) < centro(ja) : pertoDosOutros(p) < pertoDosOutros(ja));
      if (melhor) unicos.set(p.nome, p);
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
    // no celular só o leitor (um), por trás: o 1º toque no poste já não espera ele carregar.
    // Os dois leitores e a folha inteira juntos faziam o app fechar (versão 31)
    if (CELULAR) return prepararLeitura(1);
    return Promise.all([prepararLeitura(1), prepararLeitura(2), inclinacaoDaFolha(proj, pag)]);
  }

  window.Croqui = { Visor, imagem, paginas, paraPdf, croquiAnotado, acharPosteSimbolo, postesPerto, linhaDoVao, AZUL, prepararLeitura, prepararProjeto, acharPontos, corrigirNumeros, juntarCroquis, lerPoste, lerProjeto, COR_COM, COR_SEM };
})();
