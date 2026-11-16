# Medição por Croqui (Teccel)

App de celular para o **supervisor** medir a obra **em cima do projeto**: anexa o
projeto da obra (PDF ou foto), abre o croqui, toca no poste e lança ali os serviços
feitos, com os mesmos códigos, serviços e valores do Termômetro. Feito a partir do
app **Medição de Campo** (mesmo login, catálogo, fotos, Excel e PDF).

## Como funciona
1. **Nova obra**: anexa o projeto (PDF ou foto). Se o nome do arquivo tem o número
   da obra (ex.: `0032503206.pdf`), o número já vem preenchido.
2. **Croqui**: o projeto abre em tela cheia. Dois dedos aproximam, um dedo arrasta,
   toque duplo aproxima (no computador: rodinha do mouse e arrastar).
3. **Toque no poste** (ou no nome dele no projeto, ex.: `F.P1`) → "Novo ponto aqui".
   O app lê o nome do poste escrito no projeto em volta do toque (OCR, Tesseract.js
   5.1.1 pelo jsDelivr, ~7 MB baixados uma vez e guardados pelo `sw.js`) e já preenche
   `P1`; se não achar, sugere o próximo (P1, P2...). Se o P1 já existe, oferece abrir
   ele ou, se está fora do croqui, marcá-lo ali. **Criar e lançar serviços** abre o
   ponto: serviços (botões rápidos ou busca), fotos e observação, igual à Medição de
   Campo. "Concluir ponto" volta ao croqui no mesmo zoom.
4. **Toque num ponto marcado** → embaixo (ou ao lado, com o celular deitado) aparece
   o que foi feito nele: serviços com quantidade, valor e fotos, sem sair do croqui.
   Dali: **Lançar serviços e fotos** ou **Mudar lugar**.
5. Cores: verde = ponto com serviço; laranja = ponto marcado ainda sem serviço;
   vermelho = ponto escolhido.
6. **☰ Pontos**: a lista da obra (como na Medição de Campo), com "Serviços da obra
   (sem ponto)" e ponto fora do croqui. Ponto fora do croqui pode ser posto no lugar
   depois (no ponto: "📌 Marcar no croqui").
7. **Gerar medição**: Excel igual ao da Medição de Campo; o PDF ganha a **folha do
   croqui com todos os pontos marcados** e, na folha de cada ponto, o **pedaço do
   croqui em volta dele**.

A posição do ponto fica guardada em fração da folha (`croqui: { pag, x, y }`), então
continua certa em qualquer celular, tela ou zoom. Projeto de várias folhas: troca de
folha embaixo do croqui.

Tudo fica guardado **no celular** (IndexedDB `medicao-croqui`, inclusive o projeto) e
funciona **sem internet** depois de aberto uma vez com sinal.

## Banco (Supabase "setor_de_qualidade")
Mesmo projeto da Medição de Campo. Rodar uma vez `supabase/01_croqui.sql` no SQL
Editor: cria `medicao_croqui_obras`, a view `medicao_croqui_obras_lista` e o bucket
privado `medicao-croqui` (fotos em `<obra>/<foto>.jpg`, projeto em
`projetos/<obra>.pdf`). Login, supervisores e catálogo são os da Medição de Campo
(quem entra num app entra no outro); as obras ficam separadas.

## Arquivos
- `croqui.js`: visor do projeto (pdf.js), zoom/arrasto/toque, marcas dos pontos e as
  imagens do croqui para o PDF.
- `index.html`, `app.css`, `app.js`: telas (a do croqui é `telaCroqui`).
- `medicao.js`: contas e Excel/PDF (igual à Medição de Campo + folhas do croqui).
- `banco.js`: banco do aparelho (obras, fotos, projetos).
- `nuvem.js` e `config.js`: login e envio ao Supabase.
- `painel.html`, `painel.js`: painel do escritório das obras do croqui.
- `sw.js`, `manifest.webmanifest`, `icones/`: app instalável e sem internet. Mudou
  arquivo servido → subir o número em `versao.js`.
- Bibliotecas pelo cdnjs: pdf.js 3.11.174, ExcelJS 4.4.0, jsPDF 2.5.1,
  jsPDF-AutoTable 3.8.2.

## Testar no computador
```
python -m http.server 5630 --directory medicao-croqui
```
e abrir http://localhost:5630. A página `exemplo/teste.html` (fora do git) simula o
banco e usa o catálogo de teste, sem tocar no Supabase.
