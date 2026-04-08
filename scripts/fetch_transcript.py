#!/usr/bin/env python3
"""
Helper: fetches transcript for a single YouTube video ID.
Outputs JSON to stdout. Called by ingest-temach.js.
Usage: python3 scripts/fetch_transcript.py VIDEO_ID
"""
import sys
import json
import warnings
warnings.filterwarnings('ignore')

video_id = sys.argv[1] if len(sys.argv) > 1 else ''
if not video_id:
    print(json.dumps({'ok': False, 'error': 'No video ID provided'}))
    sys.exit(1)

try:
    from youtube_transcript_api import YouTubeTranscriptApi
    api = YouTubeTranscriptApi()
    # Try languages in priority order
    transcript = None
    for langs in [['es', 'es-419', 'es-MX', 'es-AR'], ['en'], None]:
        try:
            transcript = api.fetch(video_id, languages=langs) if langs else api.fetch(video_id)
            break
        except Exception:
            continue
    if transcript is None:
        raise Exception('No transcript available in any language')
    snippets = [
        {'text': s.text, 'offset': int(s.start * 1000), 'duration': int(s.duration * 1000)}
        for s in transcript.snippets
        if s.text and s.text.strip()
    ]
    print(json.dumps({'ok': True, 'transcript': snippets}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)[:120]}))
