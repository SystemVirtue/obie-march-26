#!/bin/bash
# Quick command to import a single YouTube playlist
# Usage: ./import-single-playlist.sh <PLAYLIST_ID> <PLAYLIST_NAME>

set -e

PLAYLIST_ID="$1"
PLAYLIST_NAME="$2"

if [ -z "$PLAYLIST_ID" ] || [ -z "$PLAYLIST_NAME" ]; then
  echo "Usage: ./import-single-playlist.sh <YOUTUBE_PLAYLIST_ID> <NAME>"
  echo ""
  echo "Example:"
  echo "  ./import-single-playlist.sh PLN9QqCogPsXIoSObV0F39OZ_MlRZ9tRT9 \"My Playlist\""
  exit 1
fi

SUPABASE_URL="${SUPABASE_URL:-http://localhost:54321}"
SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-${VITE_SUPABASE_SERVICE_KEY:-}}}"

if [ -z "$SERVICE_ROLE_KEY" ]; then
  if curl -s "${SUPABASE_URL}/health" >/dev/null 2>&1; then
    SUPABASE_URL=$(supabase status | grep "API URL" | awk '{print $NF}')
    SERVICE_ROLE_KEY=$(supabase status | grep "Secret key" | awk '{print $NF}')
  fi
fi

if [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "❌ Error: Could not resolve SERVICE_ROLE_KEY"
  echo "   Set SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY, or run against local Supabase"
  exit 1
fi

echo "🎵 Importing playlist: ${PLAYLIST_NAME}"
echo "   YouTube ID: ${PLAYLIST_ID}"
echo ""

# Create playlist
echo "📝 Creating playlist in database..."
CREATE_RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/playlist-manager" \
  -H "Content-Type: application/json" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -d "{
    \"action\": \"create\",
    \"player_id\": \"00000000-0000-0000-0000-000000000001\",
    \"name\": \"${PLAYLIST_NAME}\"
  }")

DB_PLAYLIST_ID=$(echo "$CREATE_RESPONSE" | grep -o '"playlist":{[^}]*"id":"[^"]*"' | grep -o '"id":"[^"]*"' | cut -d '"' -f4)

if [ -z "$DB_PLAYLIST_ID" ]; then
  echo "❌ Failed to create playlist"
  echo "Response: ${CREATE_RESPONSE}"
  exit 1
fi

echo "✅ Playlist created: ${DB_PLAYLIST_ID}"
echo ""

# Import videos
echo "🔍 Importing videos from YouTube..."
YOUTUBE_URL="https://www.youtube.com/playlist?list=${PLAYLIST_ID}"

SCRAPE_RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/playlist-manager" \
  -H "Content-Type: application/json" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -d "{
    \"action\": \"scrape\",
    \"playlist_id\": \"${DB_PLAYLIST_ID}\",
    \"url\": \"${YOUTUBE_URL}\"
  }")

COUNT=$(echo "$SCRAPE_RESPONSE" | grep -o '"count":[0-9]*' | cut -d ':' -f2)

if [ -z "$COUNT" ] || [ "$COUNT" = "0" ]; then
  echo "❌ Failed to import videos"
  echo "Response: ${SCRAPE_RESPONSE}"
  exit 1
fi

echo "✅ Successfully imported ${COUNT} videos!"
echo ""
echo "View in Admin: http://localhost:5173"
