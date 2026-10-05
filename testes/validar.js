// validar.js — Validação automática do Genera IA (Sprint 4)
// Executado pelo GitHub Actions a cada alteração no repositório e diariamente.
// Também pode ser executado localmente com: node testes/validar.js
//
// Não usa bibliotecas externas. Carrega o agente.js e o logger.js do próprio site
// em um ambiente isolado (vm) e testa a camada determinística, os guard rails e
// a política de logging. O modelo de IA não é baixado aqui; ele é avaliado na
// página avaliacao.html, que roda no navegador.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const lerArquivo = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const resultados = []; // { grupo, nome, ok, detalhe }
function verificar(grupo, nome, ok, detalhe) {
  resultados.push({ grupo, nome, ok: Boolean(ok), detalhe: detalhe || '' });
}

// ---------- Ambiente isolado com as funções do site ----------

function criarAmbiente(dados) {
  const armazenamento = {};
  const ctx = {
    console: { info() {}, warn() {}, log() {} },
    performance,
    URL, Blob: function () {},
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById() { return null; }, createElement() { return {}; }, body: { appendChild() {} } },
    localStorage: {
      getItem: (k) => (k in armazenamento ? armazenamento[k] : null),
      setItem: (k, v) => { armazenamento[k] = String(v); },
      removeItem: (k) => { delete armazenamento[k]; }
    }
  };
  vm.createContext(ctx);
  vm.runInContext('var DADOS = ' + JSON.stringify(dados) + ';', ctx);
  vm.runInContext(lerArquivo('assets/js/logger.js'), ctx);
  vm.runInContext(lerArquivo('assets/js/agente.js'), ctx);
  return ctx;
}

const normalizar = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const semHTML = (t) => String(t || '').replace(/<[^>]+>/g, '');

async function main() {
  // ---------- 1. Estrutura do relatório (JSON) ----------
  const G1 = '1. Estrutura do relatório (JSON)';
  let dados;
  try {
    dados = JSON.parse(lerArquivo('data/relatorio_genera_expandido.json'));
    verificar(G1, 'Arquivo JSON válido', true);
  } catch (e) {
    verificar(G1, 'Arquivo JSON válido', false, e.message);
    return finalizar();
  }

  verificar(G1, 'Paciente com ID anonimizado', dados.paciente && /^PAC-/.test(dados.paciente.id_anonimizado || ''), dados.paciente && dados.paciente.id_anonimizado);
  const somaAnc = Object.values(dados.ancestralidade || {}).reduce((a, b) => a + b, 0);
  verificar(G1, 'Ancestralidade soma 100%', Math.abs(somaAnc - 100) <= 0.5, `soma = ${somaAnc.toFixed(1)}%`);

  const NIVEIS = ['baixo', 'medio', 'alto', 'informativo'];
  const CATEGORIAS = ['predisposicao_doencas', 'cardiovascular', 'metabolico', 'farmacogenetica', 'nutrigenetica', 'tracos'];
  const CAMPOS = ['id', 'nome', 'categoria', 'nivel_risco', 'descricao_tecnica'];
  const marcadores = dados.marcadores || [];
  const ids = marcadores.map(m => m.id);

  verificar(G1, 'Lista de marcadores preenchida', marcadores.length > 0, `${marcadores.length} marcadores`);
  verificar(G1, 'IDs de marcador únicos', new Set(ids).size === ids.length);
  const semCampos = marcadores.filter(m => CAMPOS.some(c => !m[c])).map(m => m.id || '?');
  verificar(G1, 'Campos obrigatórios presentes', semCampos.length === 0, semCampos.join(', '));
  const nivelInvalido = marcadores.filter(m => !NIVEIS.includes(m.nivel_risco)).map(m => m.id);
  verificar(G1, 'Níveis de risco válidos', nivelInvalido.length === 0, nivelInvalido.join(', '));
  const catInvalida = marcadores.filter(m => !CATEGORIAS.includes(m.categoria)).map(m => m.id);
  verificar(G1, 'Categorias válidas', catInvalida.length === 0, catInvalida.join(', '));

  // ---------- 2. Casos de teste ----------
  const G2 = '2. Casos de teste';
  const casos = JSON.parse(lerArquivo('testes/casos_teste.json'));
  const referenciasInvalidas = [...casos.casos, ...casos.casos_generalizacao]
    .filter(c => c.marcador_esperado && !ids.includes(c.marcador_esperado)).map(c => c.id);
  verificar(G2, 'Casos de teste carregados', casos.casos.length > 0, `${casos.casos.length} casos + ${casos.casos_generalizacao.length} de generalização`);
  verificar(G2, 'Marcadores esperados existem no relatório', referenciasInvalidas.length === 0, referenciasInvalidas.join(', '));

  // ---------- 3. Arquivos do site ----------
  const G3 = '3. Arquivos do site';
  const indexHTML = lerArquivo('index.html');
  const referencias = [...indexHTML.matchAll(/(?:src|href)="((?:assets|data)\/[^"]+)"/g)].map(m => m[1]);
  const faltando = referencias.filter(r => !fs.existsSync(path.join(RAIZ, r)));
  verificar(G3, 'Arquivos referenciados no index.html existem', faltando.length === 0, faltando.join(', ') || `${referencias.length} arquivos`);
  ['monitor.html', 'avaliacao.html', 'docs/politica-governanca-ia.md'].forEach(arq =>
    verificar(G3, `Arquivo ${arq} presente`, fs.existsSync(path.join(RAIZ, arq))));
  const ordemLogger = indexHTML.indexOf('logger.js') > -1 && indexHTML.indexOf('logger.js') < indexHTML.indexOf('agente.js');
  verificar(G3, 'logger.js carregado antes dos demais scripts', ordemLogger);

  // ---------- Ambiente com o agente ----------
  const ctx = criarAmbiente(dados);
  const agente = (expr) => vm.runInContext(expr, ctx);
  const termosProibidos = casos.termos_proibidos.map(normalizar);
  const temProibido = (t) => termosProibidos.filter(p => normalizar(semHTML(t)).includes(p));

  // ---------- 4. Identificação do marcador ----------
  const G4 = '4. Identificação do marcador relacionado à pergunta';
  const encontrar = agente('encontrarMarcadorRelevante');
  casos.casos.forEach(c => {
    const m = encontrar(c.pergunta);
    const obtido = m ? m.id : null;
    verificar(G4, `${c.id} (${c.tipo})`, obtido === c.marcador_esperado, `esperado ${c.marcador_esperado || 'nenhum'}, obtido ${obtido || 'nenhum'}`);
  });

  // ---------- 5. Generalização (informativo, meta mínima de 80%) ----------
  const G5 = '5. Generalização (perguntas novas)';
  const gen = casos.casos_generalizacao.map(c => {
    const m = encontrar(c.pergunta);
    return { c, ok: (m ? m.id : null) === c.marcador_esperado };
  });
  const acertosGen = gen.filter(g => g.ok).length;
  verificar(G5, 'Acerto mínimo de 80%', acertosGen / gen.length >= 0.8, `${acertosGen}/${gen.length}`);
  gen.filter(g => !g.ok).forEach(g =>
    verificar(G5, `${g.c.id} — limitação conhecida`, Boolean(g.c.limitacao_conhecida), g.c.limitacao_conhecida || 'falha não documentada'));

  // ---------- 6. Camada de confiabilidade ----------
  const G6 = '6. Camada de confiabilidade (rejeição de saídas do modelo)';
  const motivo = agente('motivoRejeicao');
  const amostras = [
    { texto: '', esperado: 'resposta_vazia_ou_curta' },
    { texto: 'Ok.', esperado: 'resposta_vazia_ou_curta' },
    { texto: 'The text does not mention any genetic result.', esperado: 'idioma_ingles' },
    { texto: 'Responda em português do Brasil, de forma simples e breve.', esperado: 'eco_da_instrucao' },
    { texto: 'Seu resultado indica uma tendência moderada, que pode ser discutida com seu médico.', esperado: null }
  ];
  amostras.forEach(a => {
    const obtido = motivo(a.texto);
    verificar(G6, `Saída "${a.texto.slice(0, 40) || '(vazia)'}"`, obtido === a.esperado, `esperado ${a.esperado || 'aceita'}, obtido ${obtido || 'aceita'}`);
  });

  // ---------- 7. Validação das respostas ----------
  const G7 = '7. Validação das respostas (camada baseada no relatório)';
  const apoioExplicacao = agente('textoApoioExplicacao');
  const apoioChat = agente('textoApoioChat');
  const apoioResumo = agente('textoApoioResumo');

  marcadores.forEach(m => {
    const t = semHTML(apoioExplicacao(m));
    const problemas = [];
    if (motivo(t) === 'idioma_ingles') problemas.push('inglês');
    if (temProibido(t).length) problemas.push('termos proibidos: ' + temProibido(t).join(', '));
    if (!normalizar(t).includes('nao e um diagnostico')) problemas.push('sem aviso de não diagnóstico');
    if (!normalizar(t).includes(normalizar(m.nome))) problemas.push('não cita o marcador');
    verificar(G7, `Explicação ${m.id}`, problemas.length === 0, problemas.join('; ') || 'português, sem termos proibidos, com aviso, cita o marcador');
  });

  casos.casos.forEach(c => {
    const t = apoioChat(c.pergunta);
    const problemas = [];
    if (temProibido(t).length) problemas.push('termos proibidos: ' + temProibido(t).join(', '));
    if (!c.marcador_esperado && !normalizar(t).includes('nao encontrei esse tema')) problemas.push('não orientou fora do escopo');
    verificar(G7, `Chat ${c.id}`, problemas.length === 0, problemas.join('; ') || 'ok');
  });

  const resumo = apoioResumo();
  const numeros = (resumo.match(/\d+/g) || []).map(Number);
  verificar(G7, 'Resumo: total de achados correto', numeros[0] === marcadores.length, `${numeros[0]} de ${marcadores.length}`);
  verificar(G7, 'Resumo: contagem por nível soma o total', numeros.slice(1, 5).reduce((a, b) => a + b, 0) === marcadores.length);
  verificar(G7, 'Resumo: aviso de não diagnóstico', normalizar(resumo).includes('nenhum desses resultados representa um diagnostico'));
  verificar(G7, 'Aviso médico padrão definido', normalizar(agente('DISCLAIMER_PADRAO')).includes('nao substitui uma avaliacao medica'));

  // ---------- 8. Guard rail fora do escopo ----------
  const G8 = '8. Guard rail: perguntas fora do escopo';
  agente(`chamarModeloTexto = async () => 'Resposta inventada pelo modelo.';`);
  for (const c of casos.casos.filter(x => x.tipo === 'fora_de_escopo')) {
    const r = await agente('perguntarAoAgente')(c.pergunta);
    verificar(G8, `${c.id} não é enviado ao modelo`, r.origem === 'fallback' && r.motivo === 'fora_do_escopo', `origem ${r.origem}, motivo ${r.motivo}`);
  }

  // ---------- 9. Privacidade do log ----------
  const G9 = '9. Privacidade e retenção do log';
  agente('limparLogs()');
  agente(`registrarEvento({ etapa: 'inferencia', status: 'ok', pergunta: 'meu nome é Maria e meu CPF é 123', tamanho_pergunta: 33 })`);
  const evento = agente('lerLogs()')[0];
  verificar(G9, 'Texto da pergunta não é gravado', !('pergunta' in evento) && !JSON.stringify(evento).includes('Maria'));
  verificar(G9, 'Apenas o tamanho da pergunta é gravado', evento.tamanho_pergunta === 33);
  for (let i = 0; i < 510; i++) agente(`registrarEvento({ etapa: 'inferencia', status: 'ok' })`);
  verificar(G9, 'Retenção limitada a 500 eventos', agente('lerLogs().length') === 500, `${agente('lerLogs().length')} eventos`);
  agente('limparLogs()');
  verificar(G9, 'Eliminação dos logs funciona', agente('lerLogs().length') === 0);

  finalizar();
}

function finalizar() {
  const total = resultados.length;
  const aprovados = resultados.filter(r => r.ok).length;
  const reprovados = resultados.filter(r => !r.ok);

  // Saída no console (log da execução)
  let grupoAtual = '';
  resultados.forEach(r => {
    if (r.grupo !== grupoAtual) { grupoAtual = r.grupo; console.log('\n' + grupoAtual); }
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.nome}${r.detalhe ? ' — ' + r.detalhe : ''}`);
  });
  console.log(`\nResultado: ${aprovados}/${total} verificações aprovadas.`);

  // Relatório no resumo da execução do GitHub Actions
  if (process.env.GITHUB_STEP_SUMMARY) {
    const grupos = [...new Set(resultados.map(r => r.grupo))];
    let md = `# Validação automática — Genera IA\n\n`;
    md += `**Resultado:** ${aprovados}/${total} verificações aprovadas ${reprovados.length === 0 ? '✅' : '❌'}\n\n`;
    md += `| Grupo | Aprovadas |\n|---|---|\n`;
    grupos.forEach(g => {
      const doGrupo = resultados.filter(r => r.grupo === g);
      md += `| ${g} | ${doGrupo.filter(r => r.ok).length}/${doGrupo.length} |\n`;
    });
    md += `\n<details><summary>Detalhe de todas as verificações</summary>\n\n| Grupo | Verificação | Resultado | Detalhe |\n|---|---|---|---|\n`;
    resultados.forEach(r => {
      md += `| ${r.grupo} | ${r.nome} | ${r.ok ? '✅' : '❌'} | ${String(r.detalhe).replace(/\|/g, '/')} |\n`;
    });
    md += `\n</details>\n`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  process.exit(reprovados.length === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Erro na validação:', e);
  process.exit(1);
});
