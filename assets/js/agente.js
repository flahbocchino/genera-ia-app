// agente.js — Agente de linguagem (Sprint 4: Produção e Governança)
// IA rodando 100% no navegador via transformers.js — sem conta, sem token, sem servidor.
// Modelo: Xenova/LaMini-Flan-T5-77M (leve, roda em RAM limitada)
//
// Estratégia de confiabilidade: a IA sempre é tentada primeiro. O sistema verifica
// se a resposta saiu em português e faz sentido. Se não, usa um texto de apoio
// construído a partir dos dados reais do relatório.
//
// Novidades da Sprint 4:
// - Cada resposta é registrada no log (logger.js), com origem e motivo de rejeição.
// - Cada resposta exibe sua origem (modelo ou relatório) e o marcador usado como fonte.
// - Toda resposta do chat passa a exibir o aviso médico.
// - O chat envia ao modelo o marcador relacionado à pergunta (antes: 3 marcadores fixos).
// - O texto gerado pelo modelo é escapado antes de ser exibido.
// - Busca do marcador relacionado à pergunta corrigida após a avaliação.
// - Perguntas fora do escopo do relatório não são enviadas ao modelo (guard rail).

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const MODELO_TEXTO = 'Xenova/LaMini-Flan-T5-77M';

const DISCLAIMER_PADRAO =
  'Este conteúdo é informativo, baseado no seu relatório genético, e não substitui uma avaliação médica. Converse com seu médico para interpretar esses resultados no contexto da sua saúde.';

const GUARD_RAILS_CURTO = 'Responda em português do Brasil, de forma simples e breve. Nunca faça diagnóstico. Nunca use linguagem alarmista.';

const NIVEIS_TEXTO = {
  baixo: 'risco baixo',
  medio: 'risco médio',
  alto: 'risco alto',
  informativo: 'informativo'
};

// Quando true, o modelo não é chamado e apenas a camada determinística responde.
// Usado na página de avaliação (avaliacao.html) para comparar as duas camadas.
let MODO_SOMENTE_RELATORIO = false;

let historicoChat = [];
let libTransformers = null;
let geradorTexto = null;
let carregamentoGerador = null;

// ---------- Utilitários ----------

// Registra no log somente se o logger.js estiver carregado
function log(dados) {
  if (typeof registrarEvento === 'function') registrarEvento(dados);
}

// Impede que texto gerado pelo modelo seja interpretado como HTML
function escaparHTML(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function descreverFonte(marcador) {
  if (!marcador) return null;
  return `Fonte: ${marcador.id} · ${marcador.nome} · ${NIVEIS_TEXTO[marcador.nivel_risco] || marcador.nivel_risco}`;
}

// Selo de explicabilidade: mostra a origem da resposta e a fonte usada
function seloOrigemHTML(origem, fonte) {
  const ehModelo = origem === 'modelo';
  const rotulo = ehModelo ? 'Gerado pelo modelo de IA' : 'Gerado a partir dos dados do relatório';
  const classe = ehModelo ? 'modelo' : 'relatorio';
  const fonteHTML = fonte ? `<span class="fonte-resposta">${escaparHTML(fonte)}</span>` : '';
  return `<div class="meta-resposta"><span class="selo-origem ${classe}">${rotulo}</span>${fonteHTML}</div>`;
}

function dnaSpinnerSVG() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF3E7F" stroke-width="2" style="animation:spin 1.4s linear infinite;">
    <path d="M6 3c0 6 12 6 12 12M6 21c0-6 12-6 12-12" stroke-linecap="round"/>
  </svg>`;
}

// ---------- Carregamento do modelo ----------

async function carregarLibTransformers() {
  if (!libTransformers) {
    libTransformers = await import(TRANSFORMERS_CDN);
    libTransformers.env.backends.onnx.wasm.numThreads = 1;
  }
  return libTransformers;
}

async function getGeradorTexto(aoAtualizarStatus) {
  if (geradorTexto) return geradorTexto;
  if (aoAtualizarStatus) aoAtualizarStatus('Carregando modelo de IA local (primeira vez, pode levar 1-2 minutos)...');

  // Se o modelo já está sendo carregado por outra chamada, aguarda o mesmo carregamento
  if (carregamentoGerador) return carregamentoGerador;

  const inicio = performance.now();
  carregamentoGerador = (async () => {
    const { pipeline } = await carregarLibTransformers();
    return pipeline('text2text-generation', MODELO_TEXTO, { dtype: 'q8' });
  })();

  try {
    geradorTexto = await carregamentoGerador;
    log({ etapa: 'carga_modelo', status: 'ok', latencia_ms: performance.now() - inicio });
    return geradorTexto;
  } catch (e) {
    carregamentoGerador = null;
    log({ etapa: 'carga_modelo', status: 'falha', latencia_ms: performance.now() - inicio, mensagem_erro: e.message });
    throw e;
  }
}

// Retorna o texto gerado pelo modelo, ou null se o modelo não estiver disponível
async function chamarModeloTexto(instrucao, aoAtualizarStatus, funcionalidade) {
  let gerador;
  try {
    gerador = await getGeradorTexto(aoAtualizarStatus);
  } catch (e) {
    console.warn('Modelo local indisponível:', e.message);
    return null;
  }

  try {
    const prompt = `${GUARD_RAILS_CURTO} ${instrucao}`;
    const resultado = await gerador(prompt, { max_new_tokens: 80, repetition_penalty: 1.3, no_repeat_ngram_size: 3 });
    const texto = Array.isArray(resultado) ? resultado[0].generated_text : resultado.generated_text;
    return (texto || '').trim();
  } catch (e) {
    console.warn('Falha na inferência do modelo:', e.message);
    log({ etapa: 'inferencia', funcionalidade: funcionalidade || null, status: 'falha', mensagem_erro: e.message });
    return null;
  }
}

// ---------- Camada de confiabilidade ----------

// Retorna null se a resposta for aceitável, ou o motivo da rejeição.
// Critérios idênticos aos da Sprint 3; agora o motivo é registrado no log.
function motivoRejeicao(texto) {
  if (!texto || texto.length < 12) return 'resposta_vazia_ou_curta';

  const indicadoresIngles = /\b(the|is|does|not|mention|provided|text|any|this|that|with|and)\b/i;
  const palavrasIngles = (texto.match(indicadoresIngles) || []).length;
  if (palavrasIngles >= 2) return 'idioma_ingles';

  const textoLower = texto.toLowerCase();
  const fragmentosEco = [
    'nunca faça diagn', 'linguagem alarmista', 'não substitui', 'de forma simples e breve',
    'responda em português', 'lembre que', 'nunca use', 'forma simples', 'português do brasil'
  ];
  if (fragmentosEco.some(frag => textoLower.includes(frag))) return 'eco_da_instrucao';

  return null;
}

// Mantida por compatibilidade com o código da Sprint 3
function respostaConfiavel(texto) {
  return motivoRejeicao(texto) === null;
}

// Núcleo do agente: tenta o modelo, valida, usa o texto de apoio se necessário,
// registra o evento e devolve a resposta com sua origem rastreável.
async function responderComRastreio({ instrucao, funcionalidade, aoAtualizarStatus, fallback, marcador, tamanhoPergunta }) {
  const inicio = performance.now();
  let respostaModelo = null;
  let motivo;

  if (MODO_SOMENTE_RELATORIO) {
    motivo = 'modo_somente_relatorio';
  } else {
    respostaModelo = await chamarModeloTexto(instrucao, aoAtualizarStatus, funcionalidade);
    motivo = respostaModelo === null ? 'modelo_indisponivel' : motivoRejeicao(respostaModelo);
  }

  const origem = motivo ? 'fallback' : 'modelo';
  const texto = motivo ? fallback() : respostaModelo;
  const latencia = performance.now() - inicio;

  let status = 'ok';
  if (motivo && motivo !== 'modo_somente_relatorio') status = 'rejeitado';

  log({
    etapa: motivo ? 'fallback' : 'inferencia',
    funcionalidade,
    status,
    origem_resposta: origem,
    motivo_rejeicao: motivo || null,
    marcador_id: marcador ? marcador.id : null,
    tamanho_pergunta: typeof tamanhoPergunta === 'number' ? tamanhoPergunta : null,
    latencia_ms: latencia
  });

  return {
    texto,
    origem,
    motivo: motivo || null,
    marcador: marcador || null,
    resposta_modelo: respostaModelo,
    latencia_ms: Math.round(latencia)
  };
}

// ---------- Explicação simplificada de um marcador (usado no modal) ----------

async function explicarMarcador(marcador, aoAtualizarStatus) {
  return responderComRastreio({
    instrucao: `Explique de forma simples este achado genético: ${marcador.nome}, risco ${marcador.nivel_risco}.`,
    funcionalidade: 'explicacao',
    aoAtualizarStatus,
    fallback: () => textoApoioExplicacao(marcador),
    marcador,
    tamanhoPergunta: null
  });
}

async function gerarExplicacaoSimplificada(marcador) {
  const statusEl = document.getElementById('modal-explicacao');
  const atualizarStatus = (msg) => {
    if (statusEl) statusEl.innerHTML = `<div class="loading-dna">${dnaSpinnerSVG()}<span>${msg}</span></div>`;
  };

  const r = await explicarMarcador(marcador, atualizarStatus);
  const corpo = r.origem === 'modelo' ? escaparHTML(r.texto) : r.texto;

  return `<p>${corpo}</p>${seloOrigemHTML(r.origem, descreverFonte(marcador))}<p style="margin-top:14px;font-size:12px;color:var(--text-dim);border-top:1px solid var(--border);padding-top:10px;">${DISCLAIMER_PADRAO}</p>`;
}

// Texto de apoio: construído a partir dos dados reais do marcador
function textoApoioExplicacao(marcador) {
  const intros = {
    baixo: 'Seu relatório indica uma predisposição genética baixa relacionada a',
    medio: 'Seu relatório indica uma predisposição genética moderada relacionada a',
    alto: 'Seu relatório indica uma predisposição genética mais relevante relacionada a',
    informativo: 'Seu relatório traz uma informação sobre'
  };
  const intro = intros[marcador.nivel_risco] || 'Seu relatório traz uma informação sobre';
  return `${intro} <strong>${marcador.nome.toLowerCase()}</strong>. Em termos técnicos: ${marcador.descricao_tecnica.toLowerCase()} Isso não é um diagnóstico — é uma indicação que pode ser útil para conversar com seu médico.`;
}

// ---------- Chat conversacional ----------

function carregarHistorico() {
  try {
    const salvo = localStorage.getItem('genera_chat_historico');
    historicoChat = salvo ? JSON.parse(salvo) : [];
  } catch (e) {
    historicoChat = [];
  }
  renderHistoricoChat();
}

function salvarHistorico() {
  localStorage.setItem('genera_chat_historico', JSON.stringify(historicoChat));
}

function renderHistoricoChat() {
  const container = document.getElementById('chat-historico');
  if (!container) return;
  container.innerHTML = '';
  historicoChat.forEach(msg => adicionarMensagemDOM(msg.autor, msg.texto, { origem: msg.origem, fonte: msg.fonte }));
  container.scrollTop = container.scrollHeight;
}

function adicionarMensagemDOM(autor, texto, meta) {
  const container = document.getElementById('chat-historico');
  if (!container) return;

  const div = document.createElement('div');
  div.className = 'msg ' + autor;

  const corpo = document.createElement('span');
  corpo.textContent = texto;
  div.appendChild(corpo);

  if (autor === 'agente') {
    if (meta && meta.origem) {
      const temp = document.createElement('div');
      temp.innerHTML = seloOrigemHTML(meta.origem, meta.fonte);
      div.appendChild(temp.firstElementChild);
    }
    const aviso = document.createElement('span');
    aviso.className = 'aviso-msg';
    aviso.textContent = DISCLAIMER_PADRAO;
    div.appendChild(aviso);
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// Encontra o marcador do relatório mais relacionado com a pergunta do paciente.
// Ajuste da Sprint 4 (identificado na avaliação): ignora acentos, parênteses e
// palavras genéricas, aceita variações de plural/singular e dá mais peso ao nome
// do marcador do que à categoria e à descrição técnica.
const PALAVRAS_GENERICAS = [
  'risco', 'predisposicao', 'metabolismo', 'genetica', 'genetico', 'variante', 'associada',
  'associado', 'associadas', 'relacionada', 'identificada', 'gene', 'sobre', 'minha', 'minhas',
  'tenho', 'qual', 'como', 'resultado', 'relatorio', 'significa', 'quer', 'dizer', 'isso', 'esta'
];

function normalizarTexto(texto) {
  return String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function extrairPalavras(texto) {
  return normalizarTexto(texto)
    .split(/[^a-z0-9]+/)
    .filter(p => p.length > 3 && !PALAVRAS_GENERICAS.includes(p));
}

// Duas palavras combinam se forem iguais ou tiverem o mesmo início (plural/singular)
function palavrasCombinam(a, b) {
  if (a === b) return true;
  return a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6);
}

function encontrarMarcadorRelevante(perguntaTexto) {
  const palavrasPergunta = extrairPalavras(perguntaTexto);
  const aparece = (palavra) => palavrasPergunta.some(p => palavrasCombinam(p, palavra));

  let melhor = null;
  let melhorPontuacao = 0;

  DADOS.marcadores.forEach(m => {
    const pontosNome = [...new Set(extrairPalavras(m.nome))].filter(aparece).length * 3;
    const pontosCategoria = [...new Set(extrairPalavras(m.categoria.replace(/_/g, ' ')))].filter(aparece).length;
    const pontosDescricao = [...new Set(extrairPalavras(m.descricao_tecnica))].filter(aparece).length;
    const pontuacao = pontosNome + pontosCategoria + pontosDescricao;

    if (pontuacao > melhorPontuacao) {
      melhorPontuacao = pontuacao;
      melhor = m;
    }
  });

  return melhorPontuacao > 0 ? melhor : null;
}

// Responde uma pergunta do paciente (usado pelo chat e pela página de avaliação).
// Guard rail da Sprint 4 (identificado na avaliação): se a pergunta não se relaciona a
// nenhum marcador do relatório, o modelo NÃO é consultado e o usuário recebe a
// orientação padrão. Isso impede respostas inventadas fora do escopo (ex.: preços).
async function perguntarAoAgente(texto, aoAtualizarStatus) {
  const marcador = encontrarMarcadorRelevante(texto);

  if (!marcador) {
    const respostaPadrao = textoApoioChat(texto);
    log({
      etapa: 'fallback',
      funcionalidade: 'chat',
      status: 'ok',
      origem_resposta: 'fallback',
      motivo_rejeicao: 'fora_do_escopo',
      marcador_id: null,
      tamanho_pergunta: texto.length,
      latencia_ms: 0
    });
    return { texto: respostaPadrao, origem: 'fallback', motivo: 'fora_do_escopo', marcador: null, resposta_modelo: null, latencia_ms: 0 };
  }

  return responderComRastreio({
    instrucao: `Contexto do relatório: ${marcador.nome}, risco ${marcador.nivel_risco}. ${marcador.descricao_tecnica} Pergunta do paciente: ${texto}`,
    funcionalidade: 'chat',
    aoAtualizarStatus,
    fallback: () => textoApoioChat(texto),
    marcador,
    tamanhoPergunta: texto.length
  });
}

async function enviarMensagem() {
  const input = document.getElementById('chat-input');
  const texto = input.value.trim();
  if (!texto) return;

  input.value = '';
  historicoChat.push({ autor: 'usuario', texto });
  adicionarMensagemDOM('usuario', texto);
  salvarHistorico();

  const btnEnviar = document.getElementById('chat-enviar');
  btnEnviar.disabled = true;

  const pensando = document.createElement('div');
  pensando.className = 'msg agente';
  pensando.id = 'msg-pensando';
  pensando.textContent = 'Pensando...';
  document.getElementById('chat-historico').appendChild(pensando);

  const atualizarStatus = (msg) => {
    const el = document.getElementById('msg-pensando');
    if (el) el.textContent = msg;
  };

  try {
    const r = await perguntarAoAgente(texto, atualizarStatus);
    const fonte = descreverFonte(r.marcador);

    historicoChat.push({ autor: 'agente', texto: r.texto, origem: r.origem, fonte });
    adicionarMensagemDOM('agente', r.texto, { origem: r.origem, fonte });
    salvarHistorico();
  } finally {
    const el = document.getElementById('msg-pensando');
    if (el) el.remove();
    btnEnviar.disabled = false;
  }
}

// Texto de apoio do chat: responde com base no marcador mais relevante para a pergunta.
// O aviso médico é exibido separadamente em toda mensagem do agente.
function textoApoioChat(perguntaTexto) {
  const marcador = encontrarMarcadorRelevante(perguntaTexto);
  if (marcador) {
    return textoApoioExplicacao(marcador).replace(/<\/?strong>/g, '');
  }
  return 'Não encontrei esse tema específico no seu relatório. Você pode explorar os cards de risco acima para ver todos os achados disponíveis, ou reformular a pergunta citando o nome do marcador.';
}

function limparHistorico() {
  historicoChat = [];
  localStorage.removeItem('genera_chat_historico');
  const container = document.getElementById('chat-historico');
  if (container) container.innerHTML = '';
}

// ---------- Resumo automático ----------

async function resumirRelatorio(aoAtualizarStatus) {
  const contextoMarcadores = DADOS.marcadores
    .map(m => `${m.nome} (${m.nivel_risco})`)
    .slice(0, 8)
    .join(', ');

  return responderComRastreio({
    instrucao: `Resuma em poucas frases estes achados de relatório genético: ${contextoMarcadores}`,
    funcionalidade: 'resumo',
    aoAtualizarStatus,
    fallback: textoApoioResumo,
    marcador: null,
    tamanhoPergunta: null
  });
}

async function gerarResumoAutomatico() {
  const btn = document.getElementById('btn-resumo');
  const saida = document.getElementById('resumo-saida');
  btn.disabled = true;

  const atualizarStatus = (msg) => {
    saida.innerHTML = `<div class="loading-dna">${dnaSpinnerSVG()}<span>${msg}</span></div>`;
  };
  atualizarStatus('Gerando resumo com IA...');

  try {
    const r = await resumirRelatorio(atualizarStatus);
    const corpo = r.origem === 'modelo' ? escaparHTML(r.texto) : r.texto;
    const total = DADOS.marcadores.length;
    const fonte = r.origem === 'modelo'
      ? `Fonte: 8 de ${total} marcadores do relatório`
      : `Fonte: todos os ${total} marcadores do relatório`;

    saida.innerHTML = `<p>${corpo}</p>${seloOrigemHTML(r.origem, fonte)}<p style="margin-top:10px;font-size:12px;color:var(--text-dim);">${DISCLAIMER_PADRAO}</p>`;
    localStorage.setItem('genera_ultimo_resumo', r.texto);
  } finally {
    btn.disabled = false;
  }
}

// Texto de apoio do resumo: construído contando os achados reais por nível de risco
function textoApoioResumo() {
  const contagem = { baixo: 0, medio: 0, alto: 0, informativo: 0 };
  DADOS.marcadores.forEach(m => { contagem[m.nivel_risco] = (contagem[m.nivel_risco] || 0) + 1; });

  const categorias = [...new Set(DADOS.marcadores.map(m => m.categoria.replace(/_/g, ' ')))];

  return `Seu relatório reúne ${DADOS.marcadores.length} achados, distribuídos entre as categorias de ${categorias.join(', ')}. ` +
    `Ao todo, ${contagem.alto} achado(s) indicam predisposição mais relevante, ${contagem.medio} predisposição moderada e ${contagem.baixo} predisposição baixa, além de ${contagem.informativo} achado(s) informativos sobre traços e ancestralidade. ` +
    `Nenhum desses resultados representa um diagnóstico — todos são pontos de partida para conversar com seu médico.`;
}

// ---------- Inicialização (somente na página principal) ----------

document.addEventListener('DOMContentLoaded', () => {
  const btnEnviar = document.getElementById('chat-enviar');
  if (!btnEnviar) return; // outras páginas (ex.: avaliacao.html) reutilizam este arquivo sem o chat

  carregarHistorico();
  btnEnviar.addEventListener('click', enviarMensagem);
  document.getElementById('chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') enviarMensagem();
  });
  document.getElementById('btn-limpar-chat').addEventListener('click', limparHistorico);
  document.getElementById('btn-resumo').addEventListener('click', gerarResumoAutomatico);
});
