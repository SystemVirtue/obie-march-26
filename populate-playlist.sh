#!/bin/bash
# Populate Default Playlist from YouTube
# This script loads the default playlist (PLN9QqCogPsXIoSObV0F39OZ_MlRZ9tRT9) into the jukebox

set -e

echo "🎵 Populating default playlist from YouTube..."

# Configuration
SUPABASE_URL="${SUPABASE_URL:-http://localhost:54321}"
YOUTUBE_PLAYLIST_URL="https://www.youtube.com/playlist?list=PLN9QqCogPsXIoSObV0F39OZ_MlRZ9tRT9"
DEFAULT_PLAYLIST_ID="00000000-0000-0000-0000-000000000002"

# Check if Supabase is running
if ! curl -s "${SUPABASE_URL}/health" > /dev/null 2>&1; then
  echo "❌ Error: Supabase is not running at ${SUPABASE_URL}"
  echo "   Please start Supabase with: supabase start"
  exit 1
fi

# Get API keys from Supabase status
echo "📋 Getting Supabase credentials..."
ANON_KEY=$(supabase status -o env | grep ANON_KEY | cut -d '=' -f2)

if [ -z "$ANON_KEY" ]; then
  echo "❌ Error: Could not get Supabase anon key"
  echo "   Make sure Supabase is running: supabase start"
  exit 1
fi

# Check if YouTube API key is set
if [ -z "$YOUTUBE_API_KEY" ]; then
  echo "ℹ️  Note: YOUTUBE_API_KEY environment variable is not set"
  echo "   The Edge Function will use built-in rotating API keys"
  echo ""
fi

# Call playlist-manager to scrape the YouTube playlist
echo "🔍 Fetching playlist from YouTube..."
echo "   URL: ${YOUTUBE_PLAYLIST_URL}"

RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/playlist-manager" \
  -H "Content-Type: application/json" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d "{
    \"action\": \"scrape\",
    \"playlist_id\": \"${DEFAULT_PLAYLIST_ID}\",
    \"url\": \"${YOUTUBE_PLAYLIST_URL}\"
  }")

# Check for errors
if echo "$RESPONSE" | grep -q '"error"'; then
  echo "❌ Error: $(echo "$RESPONSE" | grep -o '"error":"[^"]*"' | cut -d '"' -f4)"
  echo ""
  echo "Full response:"
  echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
  exit 1
fi

# Parse and display results
COUNT=$(echo "$RESPONSE" | grep -o '"count":[0-9]*' | cut -d ':' -f2)

if [ -z "$COUNT" ] || [ "$COUNT" = "0" ]; then
  echo "⚠️  No videos found"
  exit 1
fi

echo "✅ Successfully imported ${COUNT} videos!"
echo ""
echo "📊 Playlist Details:"
echo "   Playlist ID: ${DEFAULT_PLAYLIST_ID}"
echo "   Videos: ${COUNT}"
echo ""
echo "🎉 Default playlist is ready to play!"
echo ""
echo "Next steps:"
echo "1. Open Admin console: http://localhost:5173"
echo "2. Go to Playlists tab"
echo "3. View 'Main Playlist' with your imported songs"
echo "4. Start the Player: http://localhost:5174"
