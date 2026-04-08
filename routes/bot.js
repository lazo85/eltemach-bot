const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { authMiddleware } = require('../middleware/auth');
const { getDb } = require('../database/db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const KB_FILE = path.join(__dirname, '../data/temach-knowledge.json');

// ─── Load knowledge base ──────────────────────────────────────────────────────
let knowledgeBase = null;
let allChunks = [];
let videoIndex = [];

function loadKB() {
  if (!fs.existsSync(KB_FILE)) return false;
  try {
    knowledgeBase = JSON.parse(fs.readFileSync(KB_FILE, 'utf-8'));
    allChunks = [];
    for (const video of knowledgeBase.videos) {
      for (const chunk of video.chunks) {
        allChunks.push({
          videoId: video.id,
          videoTitle: video.title,
          videoUrl: video.url,
          text: chunk.text,
          type: 'transcript'
        });
      }
    }
    videoIndex = (knowledgeBase.videoIndex || []).map(v => ({
      videoId: v.id,
      videoTitle: v.title,
      videoUrl: v.url,
      text: v.title,
      type: 'title'
    }));
    console.log(`  [ELTEMACH Bot] KB cargado: ${knowledgeBase.metadata.videoCount} videos con transcripción, ${videoIndex.length} en índice, ${allChunks.length} chunks`);
    return true;
  } catch (err) {
    console.error('  [ELTEMACH Bot] Error cargando KB:', err.message);
    return false;
  }
}

loadKB();

fs.watchFile(KB_FILE, { interval: 5000 }, () => {
  console.log('  [ELTEMACH Bot] KB actualizado, recargando...');
  loadKB();
});

// ─── Search ───────────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al',
  'a', 'en', 'por', 'para', 'con', 'sin', 'es', 'son', 'fue', 'han', 'que',
  'se', 'si', 'no', 'y', 'o', 'e', 'pero', 'me', 'te', 'le', 'mi', 'tu',
  'su', 'nos', 'les', 'lo', 'como', 'mas', 'muy', 'ya', 'hay', 'the', 'of',
  'and', 'in', 'is', 'to', 'that', 'it', 'for', 'on', 'are', 'was',
  'this', 'with', 'be', 'from', 'or', 'an', 'have', 'at', 'not', 'what'
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function scoreChunk(chunkTokens, queryTokens) {
  let score = 0;
  const chunkSet = new Set(chunkTokens);
  for (const qt of queryTokens) {
    if (chunkSet.has(qt)) score += 2;
    for (const ct of chunkTokens) {
      if (ct !== qt && (ct.includes(qt) || qt.includes(ct))) score += 0.5;
    }
  }
  return score;
}

function searchKB(query, topTranscripts = 5, topTitles = 8) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { chunks: [], titles: [] };

  const scoredChunks = allChunks.map(chunk => ({
    chunk,
    score: scoreChunk(tokenize(chunk.text), queryTokens)
  }));
  scoredChunks.sort((a, b) => b.score - a.score);

  const vidCount = {};
  const chunks = [];
  for (const s of scoredChunks.filter(s => s.score > 0)) {
    const vid = s.chunk.videoId;
    if ((vidCount[vid] || 0) < 2) {
      chunks.push(s.chunk);
      vidCount[vid] = (vidCount[vid] || 0) + 1;
      if (chunks.length >= topTranscripts) break;
    }
  }

  const scoredTitles = videoIndex.map(v => ({
    v,
    score: scoreChunk(tokenize(v.text), queryTokens)
  }));
  scoredTitles.sort((a, b) => b.score - a.score);
  const titles = scoredTitles
    .filter(s => s.score > 0)
    .slice(0, topTitles)
    .map(s => s.v);

  return { chunks, titles };
}

// ─── System prompt ────────────────────────────────────────────────────────────
const BASE_SYSTEM = `Eres el asistente virtual oficial del canal de YouTube "ELTEMACH" (El Temach).
ELTEMACH es un creador de contenido mexicano conocido por hablar sobre masculinidad, relaciones, psicología del comportamiento, autodesarrollo para hombres, el concepto de "alfa" vs "simp", análisis de películas/series/canciones, y relatos de terror/historias de vida.

Tu rol: responder preguntas basándote en el contenido real del canal.

REGLAS:
- Usa el contexto de transcripciones cuando esté disponible — es la fuente más rica.
- Cuando no hay transcripción, usa los títulos para inferir de qué tratan los videos del canal.
- Habla con el estilo de ELTEMACH: directo, sin rodeos, práctico, motivador, con actitud.
- Si no tienes suficiente información, dilo claro y menciona qué videos del canal podrían tener la respuesta.
- Nunca inventes citas textuales que no estén en el contexto.
- Respuestas concisas: 3-6 oraciones salvo que te pidan más detalle.`;

function buildSystemPrompt(chunks, titles) {
  let prompt = BASE_SYSTEM;

  if (chunks.length > 0) {
    const ctxText = chunks.map((c, i) =>
      `--- Transcripción ${i + 1} (Video: "${c.videoTitle}")\n${c.text}`
    ).join('\n\n');
    prompt += `\n\nTRANSCRIPCIONES RELEVANTES:\n${ctxText}`;
  }

  if (titles.length > 0) {
    const titleList = titles.map(t => `- "${t.videoTitle}"`).join('\n');
    prompt += `\n\nVIDEOS RELACIONADOS DEL CANAL (por título):\n${titleList}`;
  }

  if (chunks.length === 0 && titles.length === 0) {
    prompt += '\n\n[Sin contexto directo disponible. Responde basándote en lo que sabes sobre el canal ELTEMACH por sus títulos y temáticas generales.]';
  }

  return prompt;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  if (!knowledgeBase) {
    return res.json({
      ready: false,
      message: 'Base de conocimiento no encontrada. Ejecuta: npm run ingest'
    });
  }
  res.json({
    ready: true,
    channel: knowledgeBase.metadata.channel,
    videoCount: knowledgeBase.metadata.videoCount,
    totalVideos: knowledgeBase.metadata.totalVideos || knowledgeBase.metadata.videoCount,
    chunkCount: knowledgeBase.metadata.totalChunks,
    lastUpdated: knowledgeBase.metadata.lastUpdated
  });
});

router.post('/chat', authMiddleware, async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages es requerido' });
  }

  if (!knowledgeBase) {
    return res.status(503).json({
      error: 'Base de conocimiento no disponible. Ejecuta: npm run ingest',
      needsIngest: true
    });
  }

  // Verificar tokens (admin tiene ilimitados)
  if (!req.user.is_admin) {
    const freshUser = getDb().prepare('SELECT tokens FROM users WHERE id = ?').get(req.user.id);
    if (freshUser.tokens <= 0) {
      return res.status(402).json({
        error: 'Sin tokens disponibles. Compra más desde tu perfil.',
        noTokens: true
      });
    }
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const query = lastUserMsg?.content || '';

  const { chunks, titles } = searchKB(query);

  const sources = [...new Map(
    chunks.map(c => [c.videoId, { title: c.videoTitle, url: c.videoUrl }])
  ).entries()].map(([, v]) => v);

  const systemPrompt = buildSystemPrompt(chunks, titles);

  const recentMessages = messages.slice(-16).map(m => ({
    role: m.role,
    content: m.content
  }));

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: systemPrompt,
      messages: recentMessages
    });

    const reply = response.content[0].text;

    // Descontar token (no admin)
    let tokensLeft = null;
    if (!req.user.is_admin) {
      getDb().prepare('UPDATE users SET tokens = tokens - 1 WHERE id = ?').run(req.user.id);
      getDb().prepare(
        'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
      ).run(req.user.id, 'chat_usage', -1, 'Consulta al bot');
      tokensLeft = getDb().prepare('SELECT tokens FROM users WHERE id = ?').get(req.user.id).tokens;
    }

    res.json({ reply, sources: sources.slice(0, 3), tokensLeft });
  } catch (err) {
    console.error('[ELTEMACH Bot] Error:', err.message);
    res.status(500).json({ error: 'Error al procesar la respuesta' });
  }
});

module.exports = router;
