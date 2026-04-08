/**
 * ELTEMACH Knowledge Base Builder
 *
 * Descarga todos los videos del canal @ELTEMACH y construye
 * una base de conocimiento con sus transcripciones.
 *
 * Uso:
 *   npm run ingest
 *
 * Requiere:
 *   pip3 install youtube-transcript-api
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, '../data/temach-knowledge.json');
const CHUNK_WORDS = 250;
const CHANNEL_ID  = 'UCG7pu4yj5lvVScl3HJZIYPw'; // @ELTEMACH

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchTranscriptPython(videoId) {
  try {
    const out = execSync(
      `python3 "${path.join(__dirname, 'fetch_transcript.py')}" ${videoId}`,
      { timeout: 25000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const result = JSON.parse(out.toString().trim());
    if (result.ok && result.transcript.length > 0) return result.transcript;
    return null;
  } catch (_) {
    return null;
  }
}

function chunkTranscript(parts) {
  const words = parts.map(p => p.text.trim()).join(' ').split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += CHUNK_WORDS) {
    const slice = words.slice(i, i + CHUNK_WORDS + 50);
    chunks.push({ text: slice.join(' '), startWord: i });
  }
  return chunks;
}

async function main() {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║   ELTEMACH Knowledge Base Builder        ║');
  console.log('  ╚══════════════════════════════════════════╝\n');

  try {
    execSync('python3 -c "import youtube_transcript_api"', { stdio: 'pipe' });
    console.log('  ✓ youtube-transcript-api disponible\n');
  } catch (_) {
    console.error('  ✗ Falta dependencia Python. Instala con:');
    console.error('    pip3 install youtube-transcript-api\n');
    process.exit(1);
  }

  console.log('  → Cargando lista de videos del canal @ELTEMACH...');
  const { Innertube } = require('youtubei.js');
  const yt = await Innertube.create();

  const allVideos = [];
  let tab = await (await yt.getChannel(CHANNEL_ID)).getVideos();
  let page = 1;

  while (true) {
    for (const v of tab.videos || []) {
      if (v.video_id && v.title?.text) {
        allVideos.push({
          id: v.video_id,
          title: v.title.text,
          publishedAt: v.published?.text || ''
        });
      }
    }
    console.log(`    Página ${page}: ${allVideos.length} videos`);
    if (!tab.has_continuation) break;
    tab = await tab.getContinuation();
    page++;
    await sleep(300);
  }
  console.log(`  ✓ Total videos encontrados: ${allVideos.length}\n`);

  console.log('  → Descargando transcripciones...\n');
  const processed = [];
  let ok = 0, skip = 0;

  for (let i = 0; i < allVideos.length; i++) {
    const v = allVideos[i];
    const label = `[${String(i + 1).padStart(3)}/${allVideos.length}]`;
    const titleShort = v.title.substring(0, 52).padEnd(52);
    process.stdout.write(`  ${label} ${titleShort} `);

    const transcript = fetchTranscriptPython(v.id);

    if (transcript) {
      const chunks = chunkTranscript(transcript);
      processed.push({
        id: v.id,
        title: v.title,
        publishedAt: v.publishedAt,
        url: `https://youtube.com/watch?v=${v.id}`,
        chunks
      });
      process.stdout.write(`✓ ${chunks.length} chunks\n`);
      ok++;
    } else {
      process.stdout.write(`— sin transcripción\n`);
      skip++;
    }

    await sleep(200);
  }

  const totalChunks = processed.reduce((s, v) => s + v.chunks.length, 0);
  const kb = {
    metadata: {
      channel: 'ELTEMACH',
      channelId: CHANNEL_ID,
      lastUpdated: new Date().toISOString(),
      videoCount: processed.length,
      totalVideos: allVideos.length,
      totalChunks,
      successCount: ok,
      failCount: skip
    },
    videoIndex: allVideos.map(v => ({
      id: v.id,
      title: v.title,
      publishedAt: v.publishedAt,
      url: `https://youtube.com/watch?v=${v.id}`
    })),
    videos: processed
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(kb, null, 2), 'utf-8');

  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   ¡Base de conocimiento lista!           ║`);
  console.log(`  ╠══════════════════════════════════════════╣`);
  console.log(`  ║  Videos con transcripción: ${String(ok).padEnd(14)}║`);
  console.log(`  ║  Sin transcripción:        ${String(skip).padEnd(14)}║`);
  console.log(`  ║  Chunks totales:           ${String(totalChunks).padEnd(14)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
  console.log('  Ahora visita: http://localhost:3001\n');
}

main().catch(err => {
  console.error('\n  Error fatal:', err.message);
  process.exit(1);
});
