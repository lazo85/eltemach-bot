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
- Habla con el estilo de ELTEMACH: directo, sin rodeos, práctico, motivador, con actitud.
- Si no tienes suficiente información, dilo claro pero sin mencionar videos ni links.
- Nunca inventes citas textuales que no estén en el contexto.
- NUNCA menciones títulos de videos, nombres de videos, URLs ni links en tus respuestas.
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

// ─── Test mode fallback ───────────────────────────────────────────────────────
const TEST_MODE = process.env.BOT_TEST_MODE === 'true';

function buildFallbackReply(query, chunks, titles) {
  if (chunks.length === 0 && titles.length === 0) {
    return 'No encontré contenido relacionado con esa pregunta en el canal. Intentá con otras palabras.';
  }

  let reply = '';

  if (chunks.length > 0) {
    const best = chunks[0];
    // Trim to ~400 chars for readability
    const excerpt = best.text.length > 400 ? best.text.slice(0, 400).replace(/\s\S*$/, '') + '...' : best.text;
    reply += excerpt;

    if (chunks.length > 1) {
      reply += '\n\n' + chunks.slice(1, 3).map(c => {
        const t = c.text.length > 200 ? c.text.slice(0, 200).replace(/\s\S*$/, '') + '...' : c.text;
        return t;
      }).join('\n\n');
    }
  } else if (titles.length > 0) {
    reply = 'Encontré estos temas relacionados en el canal:\n' +
      titles.slice(0, 5).map(t => `• ${t.videoTitle}`).join('\n');
  }

  return reply.trim();
}

// ─── ElevenLabs TTS ──────────────────────────────────────────────────────────
const https = require('https');

function elevenLabsTTS(text, voiceId, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (resp) => {
      if (resp.statusCode !== 200) {
        let raw = '';
        resp.on('data', d => raw += d);
        resp.on('end', () => reject(new Error(`ElevenLabs ${resp.statusCode}: ${raw}`)));
        return;
      }
      const chunks = [];
      resp.on('data', d => chunks.push(d));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// GET /api/bot/tts-config — indica al frontend si ElevenLabs está activo
router.get('/tts-config', (req, res) => {
  res.json({ enabled: !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) });
});

// POST /api/bot/speak — convierte texto a audio con ElevenLabs
router.post('/speak', authMiddleware, async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    return res.status(503).json({ error: 'TTS no configurado' });
  }

  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text requerido' });
  }

  try {
    const audioBuffer = await elevenLabsTTS(text.slice(0, 2500), voiceId, apiKey);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (err) {
    console.error('[ElevenLabs]', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

  // ── Test mode: responde directo desde la KB sin API ──────────────────────
  if (TEST_MODE) {
    const reply = buildFallbackReply(query, chunks, titles);
    let tokensLeft = null;
    if (!req.user.is_admin) {
      getDb().prepare('UPDATE users SET tokens = tokens - 1 WHERE id = ?').run(req.user.id);
      getDb().prepare(
        'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
      ).run(req.user.id, 'chat_usage', -1, 'Consulta al bot (test mode)');
      tokensLeft = getDb().prepare('SELECT tokens FROM users WHERE id = ?').get(req.user.id).tokens;
    }
    return res.json({ reply, sources: sources.slice(0, 3), tokensLeft, testMode: true });
  }

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
    console.error('[ELTEMACH Bot] Error completo:', err);
    res.status(500).json({
      error: 'Error al procesar la respuesta',
      detail: err.message || String(err)
    });
  }
});

module.exports = router;
