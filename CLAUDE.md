# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # desarrollo con --watch (recarga automática)
npm start          # producción
npm run ingest     # reconstruir la knowledge base desde YouTube
```

El ingest requiere Python:
```bash
pip3 install youtube-transcript-api
```

## Architecture

**ElTemAIch** es un chatbot de pago basado en el contenido del canal de YouTube ELTEMACH. Los usuarios reciben 3 tokens gratis al registrarse y gastan 1 token por mensaje al bot.

### Flujo de datos

1. **Ingest** (`scripts/ingest.js` + `scripts/fetch_transcript.py`): usa `youtubei.js` para listar todos los videos del canal (`CHANNEL_ID = UCG7pu4yj5lvVScl3HJZIYPw`) y `youtube-transcript-api` (Python) para descargar transcripciones. Divide cada transcripción en chunks de ~250 palabras. Escribe todo a `data/temach-knowledge.json`.

2. **Knowledge Base en memoria** (`routes/bot.js`): al arrancar el servidor, carga `temach-knowledge.json` en dos estructuras:
   - `allChunks` — texto completo de todas las transcripciones (para búsqueda semántica ligera)
   - `videoIndex` — solo títulos (para relevancias por título)
   - Usa `fs.watchFile` para recargar automáticamente si el archivo cambia.

3. **Búsqueda** (`searchKB`): TF-IDF manual sin embeddings — tokeniza quitando stop words en español e inglés, puntúa por coincidencia exacta (+2) y coincidencia parcial por substring (+0.5), devuelve top 5 chunks (máx 2 por video) y top 8 títulos relacionados.

4. **Chat** (`POST /api/bot/chat`): inyecta los chunks y títulos en el system prompt de `claude-haiku-4-5-20251001`, descuenta 1 token del usuario, devuelve respuesta + fuentes.

### Monetización — dos flujos paralelos

- **MercadoPago** (`routes/payments.js`): flujo completo con preferencias, webhook en `/api/payments/webhook`, acredita tokens automáticamente al recibir pago aprobado.
- **Manual** (`routes/tokens.js` + `routes/admin.js`): el usuario solicita un paquete → admin lo aprueba desde `/admin` → tokens acreditados. Alternativa cuando MP no está configurado.

### Base de datos

SQLite en `database/temach.db`. Schema en `database/db.js` con migraciones vía `try/catch ALTER TABLE`. Tablas: `users`, `transactions`, `purchase_requests`, `payments`.

Admin por defecto: `admin@eltemach.com` / `TemAIch2024!` (creado en `init()` si no existe).

### Auth

JWT en `Authorization: Bearer` header, expiración 7 días. `middleware/auth.js` exporta `authMiddleware` y `adminMiddleware`. Google OAuth implementado manualmente con `https` nativo (sin `google-auth-library` en runtime), el callback redirige al frontend con `?token=` en la URL.

### Variables de entorno requeridas

| Variable | Uso |
|----------|-----|
| `ANTHROPIC_API_KEY` | Chat con Claude |
| `JWT_SECRET` | Firma de tokens JWT |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Google (opcional) |
| `GOOGLE_REDIRECT_URI` | Callback OAuth (default: localhost:3001) |
| `MERCADOPAGO_ACCESS_TOKEN` | Pagos (opcional) |
| `APP_URL` | Base URL para webhooks y back_urls de MP |

### Deploy

Configurado para Render (`render.yaml`). El comando de start es `node server.js` (sin dotenv — las env vars se inyectan por Render). Localmente usa `node -r dotenv/config server.js`.
