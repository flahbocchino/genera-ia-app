// app.js — Dashboard Genera IA (Sprint 4: Produção e Governança)
//
// Novidades da Sprint 4:
// - Carga do relatório registrada no log (logger.js), com tempo e quantidade de marcadores.
// - Validação da estrutura do JSON antes de montar o painel.
// - Mensagem clara ao usuário em caso de falha na carga dos dados.

let DADOS = null;
let categoriaAtiva = 'todas';

const CAMINHO_DADOS = 'data/relatorio_genera_expandido.json';
const CAMPOS_MARCADOR = ['id', 'nome', 'categoria', 'nivel_risco', 'descricao_tecnica'];

const CORES_CATEGORIA = {
  predisposicao_doencas: '#FF6B6B',
  cardiovascular: '#F5B942',
  metabolico: '#6C8CFF',
  farmacogenetica: '#FF3E7F',
  nutrigenetica: '#4ADE9E',
  tracos: '#8B94A3'
};

const CORES_ANCESTRALIDADE = {
  europeia: '#FF3E7F',
  africana: '#F5B942',
  indigena_americana: '#4ADE9E',
  asiatica: '#6C8CFF',
  outras: '#8B94A3'
};

const LABELS_ANCESTRALIDADE = {
  europeia: 'Europeia',
  africana: 'Africana',
  indigena_americana: 'Indígena Americana',
  asiatica: 'Asiática',
  outras: 'Outras'
};

// Registra no log somente se o logger.js estiver carregado
function logApp(dados) {
  if (typeof registrarEvento === 'function') registrarEvento(dados);
}

// Confere se o JSON tem a estrutura mínima esperada. Retorna null se estiver correto,
// ou a descrição do problema encontrado.
function validarEstruturaDados(dados) {
  if (!dados || typeof dados !== 'object') return 'arquivo vazio ou inválido';
  if (!dados.paciente || !dados.paciente.id_anonimizado) return 'bloco "paciente" ausente ou incompleto';
  if (!dados.ancestralidade || typeof dados.ancestralidade !== 'object') return 'bloco "ancestralidade" ausente';
  if (!Array.isArray(dados.marcadores) || dados.marcadores.length === 0) return 'lista de marcadores ausente ou vazia';

  for (const m of dados.marcadores) {
    const faltando = CAMPOS_MARCADOR.filter(campo => !m[campo]);
    if (faltando.length > 0) return `marcador ${m.id || '(sem id)'} sem os campos: ${faltando.join(', ')}`;
  }
  return null;
}

async function init() {
  const inicio = performance.now();

  try {
    const res = await fetch(CAMINHO_DADOS);
    if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${CAMINHO_DADOS}`);
    const dados = await res.json();

    const problema = validarEstruturaDados(dados);
    if (problema) throw new Error('Estrutura do relatório inválida: ' + problema);

    DADOS = dados;
    logApp({
      etapa: 'carga_dados',
      funcionalidade: 'dashboard',
      status: 'ok',
      latencia_ms: performance.now() - inicio,
      mensagem_erro: null
    });
    console.info(`[Genera IA] Relatório carregado: ${DADOS.marcadores.length} marcadores.`);
  } catch (e) {
    logApp({
      etapa: 'carga_dados',
      funcionalidade: 'dashboard',
      status: 'falha',
      latencia_ms: performance.now() - inicio,
      mensagem_erro: e.message
    });
    mostrarErroCarga();
    return;
  }

  document.getElementById('paciente-id').textContent = DADOS.paciente.id_anonimizado;
  document.getElementById('paciente-data').textContent =
    'Relatório de ' + new Date(DADOS.paciente.data_relatorio).toLocaleDateString('pt-BR');

  renderAncestralidade();
  renderFiltros();
  renderCards();

  document.getElementById('modal-close').addEventListener('click', fecharModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') fecharModal();
  });
}

function mostrarErroCarga() {
  const grid = document.getElementById('cards-grid');
  if (grid) {
    grid.innerHTML = `<p class="aviso-erro">Não foi possível carregar o relatório agora. Recarregue a página. Se o problema continuar, consulte o painel de monitoramento.</p>`;
  }
}

function renderAncestralidade() {
  const container = document.getElementById('ancestry-bars');
  container.innerHTML = '';

  const entradas = Object.entries(DADOS.ancestralidade).sort((a, b) => b[1] - a[1]);

  entradas.forEach(([chave, valor]) => {
    const row = document.createElement('div');
    row.className = 'ancestry-row';
    row.innerHTML = `
      <div class="ancestry-label">
        <span>${LABELS_ANCESTRALIDADE[chave] || chave}</span>
        <span>${valor.toFixed(1)}%</span>
      </div>
      <div class="ancestry-track">
        <div class="ancestry-fill" style="width:${valor}%; background:${CORES_ANCESTRALIDADE[chave] || '#666'}"></div>
      </div>
    `;
    container.appendChild(row);
  });

  desenharDonut(entradas);
}

function desenharDonut(entradas) {
  const svg = document.getElementById('ancestry-donut');
  const raio = 70, cx = 80, cy = 80, espessura = 22;
  const circ = 2 * Math.PI * raio;
  let acumulado = 0;
  let elementos = '';

  entradas.forEach(([chave, valor]) => {
    const fracao = valor / 100;
    const comprimento = fracao * circ;
    elementos += `<circle cx="${cx}" cy="${cy}" r="${raio}" fill="none"
      stroke="${CORES_ANCESTRALIDADE[chave] || '#666'}" stroke-width="${espessura}"
      stroke-dasharray="${comprimento} ${circ - comprimento}"
      stroke-dashoffset="${-acumulado}"
      transform="rotate(-90 ${cx} ${cy})" />`;
    acumulado += comprimento;
  });

  svg.innerHTML = elementos;
}

function renderFiltros() {
  const categorias = ['todas', ...new Set(DADOS.marcadores.map(m => m.categoria))];
  const container = document.getElementById('filtros');
  container.innerHTML = '';

  const nomes = {
    todas: 'Todas',
    predisposicao_doencas: 'Predisposição a Doenças',
    cardiovascular: 'Cardiovascular',
    metabolico: 'Metabólico',
    farmacogenetica: 'Farmacogenética',
    nutrigenetica: 'Nutrigenética',
    tracos: 'Traços'
  };

  categorias.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filtro-btn' + (cat === categoriaAtiva ? ' ativo' : '');
    btn.textContent = nomes[cat] || cat;
    btn.addEventListener('click', () => {
      categoriaAtiva = cat;
      renderFiltros();
      renderCards();
    });
    container.appendChild(btn);
  });
}

function renderCards() {
  const container = document.getElementById('cards-grid');
  container.innerHTML = '';

  const lista = categoriaAtiva === 'todas'
    ? DADOS.marcadores
    : DADOS.marcadores.filter(m => m.categoria === categoriaAtiva);

  lista.forEach(m => {
    const card = document.createElement('div');
    card.className = 'risco-card';
    card.innerHTML = `
      <span class="risco-badge ${m.nivel_risco}">${labelRisco(m.nivel_risco)}</span>
      <h3>${m.nome}</h3>
      <p>${m.descricao_tecnica}</p>
      <span class="categoria-tag">${m.categoria.replace(/_/g, ' ')}</span>
    `;
    card.addEventListener('click', () => abrirModal(m));
    container.appendChild(card);
  });
}

function labelRisco(nivel) {
  const mapa = { baixo: 'Risco baixo', medio: 'Risco médio', alto: 'Risco alto', informativo: 'Informativo' };
  return mapa[nivel] || nivel;
}

async function abrirModal(marcador) {
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-titulo').textContent = marcador.nome;
  document.getElementById('modal-tech').textContent = marcador.descricao_tecnica;
  const explicacaoEl = document.getElementById('modal-explicacao');

  explicacaoEl.innerHTML = `
    <div class="loading-dna">
      ${dnaSpinnerSVG()}
      <span>Simplificando explicação com IA...</span>
    </div>
  `;
  overlay.classList.add('aberto');

  const explicacao = await gerarExplicacaoSimplificada(marcador);
  explicacaoEl.innerHTML = `<div class="explicacao">${explicacao}</div>`;
}

function fecharModal() {
  document.getElementById('modal-overlay').classList.remove('aberto');
}

document.addEventListener('DOMContentLoaded', init);
