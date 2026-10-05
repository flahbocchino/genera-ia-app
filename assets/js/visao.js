// visao.js — Multimodalidade: leitura de gráficos/imagens (Sprint 4: refinamento final)
// IA rodando 100% no navegador via transformers.js — sem conta, sem token, sem servidor.
// Modelo: Xenova/vit-gpt2-image-captioning (baixado uma vez e executado localmente)
//
// Refinamentos da Sprint 4:
// - Validação de tipo (PNG/JPG) e tamanho (até 5 MB) antes do processamento.
// - Descarte de descrições vazias ou curtas demais.
// - Registro de eventos no log (logger.js), sem armazenar a imagem.
// - Selo de origem na interpretação e escape da descrição gerada pelo modelo.
//
// Depende de agente.js (carregarLibTransformers, responderComRastreio, seloOrigemHTML,
// escaparHTML, log, DISCLAIMER_PADRAO).

const MODELO_VISAO = 'Xenova/vit-gpt2-image-captioning';
const TIPOS_IMAGEM_ACEITOS = ['image/png', 'image/jpeg'];
const TAMANHO_MAXIMO_MB = 5;
const MIN_PALAVRAS_LEGENDA = 3;

let captionador = null;
let carregamentoCaptionador = null;

// ---------- Carregamento do modelo de visão ----------

async function getCaptionador(aoAtualizarStatus) {
  if (captionador) return captionador;
  if (aoAtualizarStatus) aoAtualizarStatus('Carregando modelo de visão local (primeira vez, pode levar até 1 minuto)...');

  if (carregamentoCaptionador) return carregamentoCaptionador;

  const inicio = performance.now();
  carregamentoCaptionador = (async () => {
    const { pipeline } = await carregarLibTransformers();
    return pipeline('image-to-text', MODELO_VISAO, { dtype: 'q8' });
  })();

  try {
    captionador = await carregamentoCaptionador;
    log({ etapa: 'carga_modelo', funcionalidade: 'visao', status: 'ok', latencia_ms: performance.now() - inicio });
    return captionador;
  } catch (e) {
    carregamentoCaptionador = null;
    log({ etapa: 'carga_modelo', funcionalidade: 'visao', status: 'falha', latencia_ms: performance.now() - inicio, mensagem_erro: e.message });
    throw e;
  }
}

// ---------- Validações ----------

// Retorna null se o arquivo for aceitável, ou a mensagem para o usuário
function validarArquivoImagem(arquivo) {
  if (!TIPOS_IMAGEM_ACEITOS.includes(arquivo.type)) {
    return { motivo: 'tipo_invalido', mensagem: 'Formato não aceito. Envie uma imagem PNG ou JPG.' };
  }
  if (arquivo.size > TAMANHO_MAXIMO_MB * 1024 * 1024) {
    return { motivo: 'arquivo_grande', mensagem: `Imagem muito grande. O limite é de ${TAMANHO_MAXIMO_MB} MB.` };
  }
  return null;
}

function legendaUtil(legenda) {
  if (!legenda) return false;
  const palavras = legenda.trim().split(/\s+/).filter(p => p.length > 0);
  return palavras.length >= MIN_PALAVRAS_LEGENDA;
}

// ---------- Análise da imagem ----------

async function analisarImagem(arquivo) {
  const resultadoEl = document.getElementById('visao-resultado');

  const atualizarStatus = (msg) => {
    resultadoEl.innerHTML = `<div class="loading-dna">${dnaSpinnerSVG()}<span>${msg}</span></div>`;
  };

  // 1) Validação do arquivo
  const invalido = validarArquivoImagem(arquivo);
  if (invalido) {
    log({ etapa: 'visao', funcionalidade: 'visao', status: 'rejeitado', motivo_rejeicao: invalido.motivo });
    resultadoEl.innerHTML = `<p class="aviso-erro">${invalido.mensagem}</p>`;
    return;
  }

  atualizarStatus('Lendo imagem com IA local...');

  // 2) Leitura da imagem pelo modelo de visão
  let legenda = null;
  const inicio = performance.now();
  try {
    const cap = await getCaptionador(atualizarStatus);
    atualizarStatus('Analisando conteúdo da imagem...');

    const imageUrl = URL.createObjectURL(arquivo);
    try {
      const saida = await cap(imageUrl);
      legenda = Array.isArray(saida) ? saida[0].generated_text : saida.generated_text;
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  } catch (e) {
    console.warn('Modelo de visão indisponível:', e.message);
    log({ etapa: 'visao', funcionalidade: 'visao', status: 'falha', latencia_ms: performance.now() - inicio, mensagem_erro: e.message });
    resultadoEl.innerHTML = `<p class="aviso-erro">
      Não foi possível carregar o modelo de visão no seu navegador agora. Isso pode acontecer por falta de memória disponível. Tente fechar outras abas/programas e recarregar a página.
    </p>`;
    return;
  }

  const legendaValida = legendaUtil(legenda);
  log({
    etapa: 'visao',
    funcionalidade: 'visao',
    status: legendaValida ? 'ok' : 'rejeitado',
    motivo_rejeicao: legendaValida ? null : 'legenda_inutil',
    latencia_ms: performance.now() - inicio
  });

  // 3) Interpretação em linguagem acessível
  atualizarStatus('Traduzindo para linguagem acessível...');
  const r = await interpretarLegendaGrafico(legendaValida ? legenda : null);
  const corpo = r.origem === 'modelo' ? escaparHTML(r.texto) : r.texto;

  const leituraBruta = legendaValida
    ? `Leitura bruta do modelo: "${escaparHTML(legenda)}"`
    : 'Leitura bruta do modelo descartada (descrição vazia ou insuficiente).';

  resultadoEl.innerHTML = `
    <p style="font-size:12px;color:var(--text-dim);font-family:var(--font-mono);">${leituraBruta}</p>
    <p class="explicacao" style="margin-top:10px;">${corpo}</p>
    ${seloOrigemHTML(r.origem, 'Fonte: leitura automática da imagem enviada')}
    <p style="margin-top:14px;font-size:12px;color:var(--text-dim);border-top:1px solid var(--border);padding-top:10px;">
      Este conteúdo é informativo, baseado em leitura automática de imagem, e não substitui uma avaliação médica.
    </p>
  `;
}

// Usa o agente de texto para transformar a descrição técnica em explicação acessível
async function interpretarLegendaGrafico(legenda) {
  const fallback = () =>
    'A leitura automática identificou um gráfico relacionado ao relatório genético. Gráficos como esse costumam representar a distribuição de resultados por categoria (por exemplo, níveis de risco ou percentuais de ancestralidade).';

  // Sem descrição útil, não há o que interpretar: usa diretamente o texto de apoio
  if (!legenda) {
    log({ etapa: 'fallback', funcionalidade: 'visao_interpretacao', status: 'rejeitado', origem_resposta: 'fallback', motivo_rejeicao: 'legenda_inutil' });
    return { texto: fallback(), origem: 'fallback', motivo: 'legenda_inutil', marcador: null };
  }

  return responderComRastreio({
    instrucao: `Um gráfico de relatório genético foi descrito assim em inglês: "${legenda}". Explique brevemente o que esse tipo de gráfico representa.`,
    funcionalidade: 'visao_interpretacao',
    aoAtualizarStatus: null,
    fallback,
    marcador: null,
    tamanhoPergunta: null
  });
}

// ---------- Inicialização ----------

document.addEventListener('DOMContentLoaded', () => {
  const inputImagem = document.getElementById('visao-input');
  if (inputImagem) {
    inputImagem.addEventListener('change', async (e) => {
      const arquivo = e.target.files[0];
      if (arquivo) {
        await analisarImagem(arquivo);
        e.target.value = ''; // permite reenviar a mesma imagem
      }
    });
  }
});
