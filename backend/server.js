import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import Groq from 'groq-sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const BFF_KEY = process.env.BFF_KEY || 'd701a2043aa24d7ebb37e9adf60d043b';
const BFF_LOGIN_URL = 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken';
const IPTV_TOKEN_URL = 'https://edusp-api.ip.tv/registration/edusp/token';
const IPTV_BASE = 'https://edusp-api.ip.tv';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── helpers ──────────────────────────────────────────────────────────────────

function randHex(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function iptvHeaders(authToken = null) {
  const rid = randHex(32);
  const par = randHex(16);
  const h = {
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Content-Type': 'application/json',
    'Request-Id': `|${rid}.${par}`,
    'Traceparent': `00-${rid}-${par}-01`,
    'X-Api-Realm': 'edusp',
    'X-Api-Platform': 'webclient',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (authToken) h['X-Api-Key'] = authToken;
  return h;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatUserKey(ra, digito) {
  // RA sempre 12 dígitos com zeros a esquerda
  const raPad = ra.toString().replace(/\D/g, '').padStart(12, '0');
  return `${raPad}${digito}SP`;
}

// ─── ROTA: LOGIN ──────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  try {
    const { ra, digito, senha } = req.body;
    if (!ra || !digito || !senha) {
      return res.status(400).json({ error: 'RA, dígito e senha são obrigatórios.' });
    }

    const userKey = formatUserKey(ra, digito);

    // Step 1: BFF Login
    const bffResp = await fetch(BFF_LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ocp-apim-subscription-key': BFF_KEY,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://saladofuturo.educacao.sp.gov.br',
        'Referer': 'https://saladofuturo.educacao.sp.gov.br/',
      },
      body: JSON.stringify({ user: userKey, senha, tipo: 'ALUNO' }),
    });

    if (!bffResp.ok) {
      const errText = await bffResp.text();
      const msg = errText.toLowerCase().includes('incorretos') || errText.toLowerCase().includes('invalid')
        ? 'RA, dígito ou senha incorretos.'
        : 'Erro ao conectar com a Sala do Futuro.';
      return res.status(401).json({ error: msg });
    }

    const bffData = await bffResp.json();
    const sedToken = bffData.token;

    // Step 2: Trocar por auth_token IPTV
    const iptvResp = await fetch(IPTV_TOKEN_URL, {
      method: 'POST',
      headers: iptvHeaders(),
      body: JSON.stringify({ token: sedToken }),
    });

    if (!iptvResp.ok) {
      return res.status(500).json({ error: 'Falha ao autenticar na plataforma.' });
    }

    const iptvData = await iptvResp.json();
    const authToken = iptvData.auth_token;

    // Step 3: Buscar turmas
    const roomsResp = await fetch(`${IPTV_BASE}/room/user`, {
      headers: iptvHeaders(authToken),
    });

    if (!roomsResp.ok) {
      return res.status(500).json({ error: 'Falha ao buscar turmas.' });
    }

    const roomsData = await roomsResp.json();
    const rooms = roomsData.rooms || [];

    if (!rooms.length) {
      return res.status(404).json({ error: 'Nenhuma turma encontrada para este aluno.' });
    }

    // Formatar turmas para o frontend
    const turmas = rooms.map(r => ({
      id: r.id,
      name: r.name,
      topic: r.topic || r.name,
      escola: r.meta?.nome_escola || '',
      diretoria: r.meta?.nome_diretoria || '',
    }));

    // Selecionar turma padrão (a com símbolo de grau no topic, com mais 'oper')
    const comGrau = turmas.filter(t => t.topic && /[º°ª]/.test(t.topic));
    const defaultTurma = comGrau.length ? comGrau[0] : turmas[0];

    // Dados do aluno
    const alunoNome = iptvData.name || bffData.name || 'Aluno';

    return res.json({
      authToken,
      turmas,
      defaultTurmaId: defaultTurma.id,
      aluno: {
        nome: alunoNome,
        ra,
        digito,
        userKey,
      },
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// ─── ROTA: BUSCAR TAREFAS ─────────────────────────────────────────────────────

app.post('/api/tarefas', async (req, res) => {
  try {
    const { authToken, roomId, roomName, tipo } = req.body;
    // tipo: 'pendentes' | 'expiradas' | 'todas'
    if (!authToken || !roomId || !roomName) {
      return res.status(400).json({ error: 'Dados incompletos.' });
    }

    // Buscar detalhes da sala para pegar publication_targets
    const detailResp = await fetch(
      `${IPTV_BASE}/room/detail/${roomId}?fields[]=id&fields[]=name&with_category_groups=true`,
      { headers: iptvHeaders(authToken) }
    );

    let publicationTargets = [roomName];
    if (detailResp.ok) {
      const detailData = await detailResp.json();
      const groupCats = detailData.group_categories || [];
      publicationTargets = [roomName, ...groupCats.map(g => g.id)];
    }

    const fetchForTipo = async (expiredOnly) => {
      let url = `${IPTV_BASE}/tms/task/todo?expired_only=${expiredOnly}&limit=100&offset=0&filter_expired=${!expiredOnly}&is_exam=false&with_answer=true&is_essay=false`;
      publicationTargets.forEach(t => {
        url += `&publication_target=${encodeURIComponent(t)}`;
      });
      url += '&answer_statuses=draft&answer_statuses=pending&with_apply_moment=true';

      const r = await fetch(url, { headers: iptvHeaders(authToken) });
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data) ? data : (data.tasks || data.items || []);
    };

    let tasks = [];
    if (tipo === 'expiradas') {
      tasks = await fetchForTipo(true);
    } else if (tipo === 'todas') {
      const [pendentes, expiradas] = await Promise.all([fetchForTipo(false), fetchForTipo(true)]);
      // Deduplicar por id
      const seen = new Set();
      tasks = [...pendentes, ...expiradas].filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
    } else {
      // pendentes (default)
      tasks = await fetchForTipo(false);
    }

    const formatted = tasks.map(t => ({
      id: t.id,
      title: t.title || 'Sem título',
      isEssay: t.is_essay || false,
      isExam: t.is_exam || false,
      answerId: t.answer_id || 0,
      targetScore: t.target_score || 100,
      expiredAt: t.expired_at || null,
      subject: t.subject?.name || t.category?.name || '',
    }));

    return res.json({ tasks: formatted, total: formatted.length });

  } catch (err) {
    console.error('Tarefas error:', err);
    return res.status(500).json({ error: 'Erro ao buscar tarefas.' });
  }
});

// ─── ROTA: COMPLETAR TAREFA ───────────────────────────────────────────────────

app.post('/api/completar', async (req, res) => {
  const { authToken, roomName, lessonId, answerId, targetScore, useAI } = req.body;

  if (!authToken || !roomName || !lessonId) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  try {
    // Buscar info da lição
    const infoResp = await fetch(
      `${IPTV_BASE}/tms/task/${lessonId}/apply/?preview_mode=false&room_code=${roomName}`,
      { headers: iptvHeaders(authToken) }
    );

    if (!infoResp.ok) {
      return res.status(500).json({ error: `Falha ao buscar tarefa ${lessonId}` });
    }

    const lessonInfo = await infoResp.json();

    if (lessonInfo.is_essay) {
      return res.json({ status: 'skipped', reason: 'redacao' });
    }
    if (lessonInfo.is_exam) {
      return res.json({ status: 'skipped', reason: 'prova' });
    }

    // Gerar respostas via IA ou padrão
    const answers = await generateAnswers(lessonInfo, useAI);

    // Calcular tempo gasto (entre 1 e 3 min por tarefa, variável)
    const timeSpent = Math.round((60 + Math.random() * 120));

    // Submeter
    const submitResult = await submitTask({
      authToken,
      roomName,
      lessonId,
      lessonInfo,
      answers,
      answerId: answerId || 0,
      targetScore: targetScore || 100,
      timeSpent,
    });

    return res.json(submitResult);

  } catch (err) {
    console.error('Completar error:', err);
    return res.status(500).json({ error: err.message || 'Erro ao completar tarefa.' });
  }
});

// ─── ROTA: REDAÇÃO ────────────────────────────────────────────────────────────

app.post('/api/redacao', async (req, res) => {
  const { authToken, roomName, lessonId, answerId, tema } = req.body;

  if (!authToken || !roomName || !lessonId) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  try {
    const infoResp = await fetch(
      `${IPTV_BASE}/tms/task/${lessonId}/apply/?preview_mode=false&room_code=${roomName}`,
      { headers: iptvHeaders(authToken) }
    );

    if (!infoResp.ok) {
      return res.status(500).json({ error: 'Falha ao buscar redação.' });
    }

    const lessonInfo = await infoResp.json();

    // Extrair tema da redação
    const temaReal = tema || lessonInfo.title || lessonInfo.description || 'Tema livre';

    // Gerar redação com Groq
    const texto = await gerarRedacao(temaReal, lessonInfo);

    // Submeter redação
    const submitResult = await submitEssay({
      authToken,
      roomName,
      lessonId,
      lessonInfo,
      texto,
      answerId: answerId || 0,
    });

    return res.json({ ...submitResult, texto });

  } catch (err) {
    console.error('Redação error:', err);
    return res.status(500).json({ error: err.message || 'Erro ao gerar redação.' });
  }
});

// ─── ROTA: HISTORICO ──────────────────────────────────────────────────────────

// Histórico em memória (por sessão/authToken - simplificado)
const historico = new Map();

app.post('/api/historico/salvar', (req, res) => {
  const { authToken, tarefa } = req.body;
  if (!authToken || !tarefa) return res.status(400).json({ error: 'Dados inválidos.' });

  const key = authToken.slice(0, 32);
  if (!historico.has(key)) historico.set(key, []);
  historico.get(key).unshift({ ...tarefa, timestamp: new Date().toISOString() });

  // Manter só os últimos 100
  const list = historico.get(key);
  if (list.length > 100) list.length = 100;

  return res.json({ ok: true });
});

app.post('/api/historico', (req, res) => {
  const { authToken } = req.body;
  if (!authToken) return res.status(400).json({ error: 'Token inválido.' });

  const key = authToken.slice(0, 32);
  const list = historico.get(key) || [];
  return res.json({ historico: list });
});

// ─── LÓGICA DE IA ─────────────────────────────────────────────────────────────

async function generateAnswers(lessonInfo, useAI = true) {
  const questions = lessonInfo.questions || lessonInfo.items || [];
  if (!questions.length) return [];

  const answers = [];

  for (const q of questions) {
    const alternatives = q.alternatives || q.options || [];
    const qText = q.description || q.text || q.title || '';

    if (!useAI || !alternatives.length) {
      // Sem IA: escolher a de maior score ou a primeira
      const best = alternatives.reduce((a, b) =>
        (b.score || 0) > (a.score || 0) ? b : a, alternatives[0] || {});
      answers.push({
        question_id: q.id,
        alternative_id: best?.id || null,
        text: best?.description || '',
      });
      continue;
    }

    // Com IA: pedir ao Groq
    try {
      const groq = new Groq({ apiKey: GROQ_API_KEY });
      const altsText = alternatives.map((a, i) => `${i + 1}. ${a.description}`).join('\n');
      const prompt = `Você é um estudante do ensino médio brasileiro. Responda a questão abaixo escolhendo a alternativa CORRETA. Responda APENAS com o número da alternativa (ex: 2).

Questão: ${qText}

Alternativas:
${altsText}

Resposta (apenas o número):`;

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10,
        temperature: 0.1,
      });

      const resp = completion.choices[0]?.message?.content?.trim() || '1';
      const idx = (parseInt(resp.match(/\d+/)?.[0] || '1') - 1);
      const chosen = alternatives[Math.max(0, Math.min(idx, alternatives.length - 1))];

      answers.push({
        question_id: q.id,
        alternative_id: chosen?.id || null,
        text: chosen?.description || '',
      });
    } catch {
      // Fallback: primeira alternativa
      answers.push({
        question_id: q.id,
        alternative_id: alternatives[0]?.id || null,
        text: alternatives[0]?.description || '',
      });
    }
  }

  return answers;
}

async function gerarRedacao(tema, lessonInfo) {
  const groq = new Groq({ apiKey: GROQ_API_KEY });

  const minWords = lessonInfo.min_words || 250;
  const maxWords = lessonInfo.max_words || 500;
  const descricao = lessonInfo.description || '';

  const prompt = `Você é um estudante do ensino médio brasileiro de 16 anos. Escreva uma redação dissertativo-argumentativa sobre o tema abaixo.

TEMA: ${tema}
${descricao ? `CONTEXTO: ${descricao}` : ''}

INSTRUÇÕES:
- Entre ${minWords} e ${maxWords} palavras
- Linguagem natural de estudante, com pequenas imperfeições (não seja robótico)
- Estrutura: introdução, desenvolvimento (2 parágrafos), conclusão
- Use exemplos da realidade brasileira
- Não use expressões muito formais ou literárias demais
- NÃO mencione que é uma IA ou assistente

Escreva APENAS a redação, sem título, sem comentários:`;

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    temperature: 0.85,
  });

  return completion.choices[0]?.message?.content?.trim() || '';
}

// ─── LÓGICA DE SUBMISSÃO ──────────────────────────────────────────────────────

async function submitTask({ authToken, roomName, lessonId, lessonInfo, answers, answerId, targetScore, timeSpent }) {
  // Montar body de submissão
  const questions = lessonInfo.questions || lessonInfo.items || [];

  // Construir respostas no formato da API
  const answerData = {};
  for (const a of answers) {
    if (a.question_id && a.alternative_id) {
      answerData[a.question_id] = { alternative_id: a.alternative_id };
    }
  }

  // Endpoint de submissão
  const submitUrl = `${IPTV_BASE}/tms/task/${lessonId}/answer`;
  const body = {
    room_code: roomName,
    time_spent: timeSpent,
    answers: answerData,
    answer_id: answerId || undefined,
  };

  const submitResp = await fetch(submitUrl, {
    method: answerId ? 'PUT' : 'POST',
    headers: iptvHeaders(authToken),
    body: JSON.stringify(body),
  });

  if (!submitResp.ok) {
    const errText = await submitResp.text();
    throw new Error(`Falha ao submeter: ${submitResp.status} - ${errText.slice(0, 100)}`);
  }

  const result = await submitResp.json();
  const score = result.score ?? result.grade ?? result.points ?? null;

  return {
    status: 'success',
    score,
    totalQuestions: questions.length,
    answersSubmitted: answers.length,
  };
}

async function submitEssay({ authToken, roomName, lessonId, lessonInfo, texto, answerId }) {
  const submitUrl = `${IPTV_BASE}/tms/task/${lessonId}/answer`;
  const body = {
    room_code: roomName,
    time_spent: Math.round(300 + Math.random() * 300), // 5-10 min
    essay_text: texto,
    answer_id: answerId || undefined,
  };

  const submitResp = await fetch(submitUrl, {
    method: answerId ? 'PUT' : 'POST',
    headers: iptvHeaders(authToken),
    body: JSON.stringify(body),
  });

  if (!submitResp.ok) {
    const errText = await submitResp.text();
    throw new Error(`Falha ao submeter redação: ${submitResp.status} - ${errText.slice(0, 100)}`);
  }

  const result = await submitResp.json();
  return { status: 'success', result };
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Ultimato do Futuro rodando na porta ${PORT}`);
});
