// logger.js — Logging estruturado e rastreabilidade (Sprint 4)
// Registra eventos técnicos do pipeline no localStorage do navegador.
// Por política de governança (docs/politica-governanca-ia.md), NÃO registra
// o texto das perguntas, imagens ou qualquer identificador pessoal.

const LOG_CHAVE = 'genera_logs';
const LOG_LIMITE = 500;

// Lê todos os eventos registrados
function lerLogs() {
  try {
    const salvo = localStorage.getItem(LOG_CHAVE);
    return salvo ? JSON.parse(salvo) : [];
  } catch (e) {
    return [];
  }
}

// Registra um evento estruturado
// etapa: carga_dados | carga_modelo | inferencia | fallback | visao | erro
// status: ok | rejeitado | falha
function registrarEvento(dados) {
  const evento = {
    timestamp: new Date().toISOString(),
    etapa: dados.etapa || 'desconhecida',
    funcionalidade: dados.funcionalidade || null,
    status: dados.status || 'ok',
    origem_resposta: dados.origem_resposta || null,
    motivo_rejeicao: dados.motivo_rejeicao || null,
    marcador_id: dados.marcador_id || null,
    tamanho_pergunta: typeof dados.tamanho_pergunta === 'number' ? dados.tamanho_pergunta : null,
    latencia_ms: typeof dados.latencia_ms === 'number' ? Math.round(dados.latencia_ms) : null,
    mensagem_erro: dados.mensagem_erro ? String(dados.mensagem_erro).slice(0, 200) : null
  };

  try {
    const logs = lerLogs();
    logs.push(evento);
    while (logs.length > LOG_LIMITE) logs.shift(); // retenção: descarta os mais antigos
    localStorage.setItem(LOG_CHAVE, JSON.stringify(logs));
  } catch (e) {
    console.warn('[Genera IA] Não foi possível gravar o log:', e.message);
  }

  console.info('[Genera IA][log]', evento);
  return evento;
}

// Apaga todos os logs (direito de eliminação — LGPD art. 18)
function limparLogs() {
  try {
    localStorage.removeItem(LOG_CHAVE);
  } catch (e) {
    console.warn('[Genera IA] Não foi possível apagar os logs:', e.message);
  }
}

// Exporta os logs em CSV para auditoria e avaliação
function exportarLogsCSV(nomeArquivo) {
  const logs = lerLogs();
  const colunas = ['timestamp', 'etapa', 'funcionalidade', 'status', 'origem_resposta',
    'motivo_rejeicao', 'marcador_id', 'tamanho_pergunta', 'latencia_ms', 'mensagem_erro'];

  const escapar = (valor) => {
    if (valor === null || valor === undefined) return '';
    const texto = String(valor).replace(/"/g, '""');
    return /[",;\n]/.test(texto) ? `"${texto}"` : texto;
  };

  const linhas = [colunas.join(',')];
  logs.forEach(ev => linhas.push(colunas.map(c => escapar(ev[c])).join(',')));

  const blob = new Blob(['\uFEFF' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivo || 'genera_logs.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Marca o início de uma medição de tempo
function iniciarCronometro() {
  return performance.now();
}

// Retorna o tempo decorrido em milissegundos
function tempoDecorrido(inicio) {
  return performance.now() - inicio;
}

// Captura erros não tratados de qualquer parte da aplicação
window.addEventListener('error', (e) => {
  registrarEvento({ etapa: 'erro', status: 'falha', mensagem_erro: e.message });
});

window.addEventListener('unhandledrejection', (e) => {
  const motivo = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  registrarEvento({ etapa: 'erro', status: 'falha', mensagem_erro: motivo });
});
