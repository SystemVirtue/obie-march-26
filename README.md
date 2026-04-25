# Obie Jukebox v2 🎵

**A real-time, server-first jukebox system powered by Supabase**

All business logic runs on the server. Clients are thin, stateless UIs that render Realtime data and send events.


## 📌 Rebuild Status (Apr 24, 2026)

A non-destructive, production-focused rebuild comparison against Version 1 is documented in:

- [`docs/VERSION1_COMPARISON.md`](docs/VERSION1_COMPARISON.md)
- [`docs/MULTI_PLAYER_SYNC.md`](docs/MULTI_PLAYER_SYNC.md)
- [`docs/ROBUSTNESS_ASSESSMENT.md`](docs/ROBUSTNESS_ASSESSMENT.md)
- [`docs/MASTER_VIEWER_ACCEPTANCE_GATES.md`](docs/MASTER_VIEWER_ACCEPTANCE_GATES.md)

`npm test` is intentionally gated: set `RUN_E2E_INTEGRATION=true` plus required Supabase/auth env vars to execute full Playwright integration tests.

Master/viewer election is also rollout-gated: keep `VITE_ENABLE_MASTER_VIEWER_MODEL=false` until explicit failover and E2E acceptance gates are green in your target environment.


This keeps Version 1 operational context intact while defining a phased modernization path.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        SUPABASE SERVER                          │
│  (Single Source of Truth)                                       │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Postgres    │  │  Realtime    │  │    Edge      │         │
│  │   Database   │  │  Broadcast   │  │  Functions   │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│         │                  │                  │                 │
│    All state         Instant sync      Business logic          │
└─────────────────────────────────────────────────────────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   ADMIN     │    │   PLAYER    │    │   KIOSK     │
│  Console    │    │   Window    │    │  Interface  │
│             │    │             │    │             │
│ • Queue UI  │    │ • YouTube   │    │ • Search    │
│ • Playlists │    │   iframe    │    │ • Coin      │
│ • Settings  │    │ • Status    │    │ • Request   │
│ • Logs      │    │   reports   │    │   songs     │
└─────────────┘    └─────────────┘    └─────────────┘
```

### Key Principles

1. **Server-First**: All state lives in Supabase database
2. **Real-time Sync**: Changes broadcast instantly via Supabase Realtime
3. **Stateless Clients**: No localStorage, no client-side queue logic
4. **Priority Queue**: Paid kiosk requests play before normal queue
5. **Free-Tier Safe**: Optimized for Supabase free tier (<30K invocations/month)

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and npm
- Supabase account ([sign up free](https://supabase.com))
- Supabase CLI (`npm install -g supabase`)

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd obie-v5
npm install
```

### 2. Setup Supabase

#### Option A: Local Development (Recommended)

```bash
# Start Supabase locally (requires Docker)
npm run supabase:start

# This will output:
# - API URL: http://localhost:54321
# - anon key: <your-anon-key>
# - service_role key: <your-service-key>
```

#### Option B: Supabase Cloud

1. Create project at [database.new](https://database.new)
2. Go to **Settings → API** and copy:
   - Project URL
   - `anon` public key
   - `service_role` secret key

### 3. Configure Environment

Create `.env` files for each frontend app:

**`web/admin/.env`**
```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

**`web/player/.env`**
```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

**`web/kiosk/.env`**
```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

### 4. Run Database Migrations

```bash
npm run supabase:reset
```

This creates all tables, RPCs, and RLS policies.

### 5. Deploy Edge Functions (Cloud Only)

```bash
# Login to Supabase
supabase login

# Link to your project
supabase link --project-ref <your-project-ref>

# Deploy all functions
npm run supabase:deploy
```

For local dev, Edge Functions run automatically with `supabase start`.

### 6. Start Frontend Apps

```bash
# Start all apps concurrently
npm run dev
```

This opens:
- **Admin**: http://localhost:5173
- **Player**: http://localhost:5174
- **Kiosk**: http://localhost:5175

Or start individually:
```bash
npm run dev:admin
npm run dev:player
npm run dev:kiosk
```

---

## 📁 Project Structure

```
obie-v5/
├── supabase/
│   ├── functions/
│   │   ├── queue-manager/      # Queue operations (add, remove, reorder, next)
│   │   ├── player-control/     # Player status updates & heartbeat
│   │   ├── kiosk-handler/      # Search, credits, song requests
│   │   ├── playlist-manager/   # Playlist CRUD & media scraping
│   │   └── _shared/
│   │       └── cors.ts         # CORS headers
│   ├── migrations/
│   │   └── 0001_initial_schema.sql  # Complete DB schema + RPCs + RLS
│   └── config.toml             # Supabase local config
├── web/
│   ├── shared/
│   │   └── supabase-client.ts  # Types, API helpers, Realtime hooks
│   ├── admin/                  # Admin console (React + Vite)
│   ├── player/                 # Media player (React + Vite)
│   └── kiosk/                  # Public kiosk (React + Vite)
├── package.json                # Root scripts & workspace config
└── README.md                   # This file
```

---

## 🗄️ Database Schema

### Core Tables

| Table | Purpose |
|-------|---------|
| `players` | Player instances (1 per jukebox) |
| `playlists` | Playlist library |
| `playlist_items` | Songs in playlists (normalized) |
| `media_items` | Deduplicated media metadata cache |
| `queue` | Unified queue (normal + priority) |
| `player_status` | Live playback state |
| `player_settings` | Player configuration |
| `kiosk_sessions` | Kiosk session tracking + credits |
| `system_logs` | Event logs with severity |

### SQL RPCs (Remote Procedure Calls)

| RPC | Description |
|-----|-------------|
| `queue_add(...)` | Add item to queue (atomic) |
| `queue_remove(...)` | Remove item from queue |
| `queue_reorder(...)` | Reorder queue items |
| `queue_next(...)` | Get next song to play (respects priority) |
| `queue_skip(...)` | Skip current song |
| `queue_clear(...)` | Clear queue (all or by type) |
| `kiosk_increment_credit(...)` | Add credits to session |
| `kiosk_decrement_credit(...)` | Deduct credits |
| `player_heartbeat(...)` | Update player online status |

All RPCs use PostgreSQL advisory locks to prevent race conditions.

---

## 🔐 Row Level Security (RLS)

### Admin Access (Authenticated Users)
- Full read/write access to all tables
- Uses Supabase Auth for authentication

### Kiosk Access (Anonymous)
- Read-only: `media_items`, `player_settings`
- Read/write own: `kiosk_sessions`
- Cannot access: `queue`, `playlists`, `system_logs`

### Player Access (Anonymous)
- Read/write own: `player_status`
- Cannot modify queue or settings directly

---

## 📱 Frontend Apps

### 1. Admin Console (`web/admin`)

**Purpose**: Full control over jukebox

**Features**:
- Queue management with drag-drop reordering
- Player controls (play/pause/skip/clear)
- Playlist library CRUD
- Settings editor (playback, kiosk, queue limits)
- Real-time system logs viewer

**Tech**: React + Vite + TypeScript + Tailwind + @dnd-kit

**Port**: 5173

---

### 2. Player Window (`web/player`)

**Purpose**: Media playback engine

**Features**:
- YouTube iframe with autoplay
- Status reporting (playing/paused/ended)
- Heartbeat every 3 seconds (keeps player online)
- Progress tracking
- Idle/loading/error states

**Tech**: React + Vite + TypeScript + Tailwind

**Port**: 5174

**Important**: Player must be running for Admin/Kiosk to function.

---

### 3. Kiosk Interface (`web/kiosk`)

**Purpose**: Public song request terminal

**Features**:
- Touch-optimized search UI
- Real-time credit display
- Coin acceptor integration (WebSerial API ready)
- Song request with priority queue
- Free play mode support

**Tech**: React + Vite + TypeScript + Tailwind + Lucide icons

**Port**: 5175

**Coin Acceptor**: Uses dev button for testing. Replace with WebSerial API in production.

---

## 🔄 How It Works

### Song Request Flow

```
1. KIOSK: User searches → callKioskHandler('search', query)
2. SERVER: Returns matching media_items
3. KIOSK: User selects song → callKioskHandler('request', media_item_id)
4. SERVER: Checks credits/freeplay → Calls queue_add RPC → Adds to priority queue
5. PLAYER: Realtime subscription receives queue update
6. SERVER: When current song ends, queue_next RPC gets next item (priority first)
7. PLAYER: Updates player_status with new current_media_id
8. PLAYER: Realtime subscription receives status update → Loads new YouTube iframe
9. PLAYER: Reports state changes → callPlayerControl('update', state)
10. ADMIN: Sees queue update in real-time via Realtime subscription
```

### Heartbeat System

- Player sends heartbeat every 3 seconds
- `player_heartbeat()` RPC marks player as `online`
- If no heartbeat for >10 seconds, status changes to `offline`
- Admin/Kiosk can check player status before operations

---

## 🆓 Supabase Free Tier Compliance

### Estimated Monthly Usage

| Resource | Estimate | Free Limit | Status |
|----------|----------|------------|--------|
| **Invocations** | 25,500 | 500,000 | ✅ 5% |
| **CPU Time** | 21 min | 50 hours | ✅ 0.7% |
| **Bandwidth** | 127 MB | 500 GB | ✅ 0.02% |
| **Realtime Connections** | 3 | 200 | ✅ 1.5% |
| **Database Size** | <50 MB | 8 GB | ✅ 0.6% |

**Breakdown**:
- Songs played: 200/day × 2 calls = 400
- Admin actions: 50/day
- Kiosk requests: 100/day
- Status updates: 288/day (every 5 min)
- **Total**: ~850 invocations/day = **25,500/month**

**Result**: Comfortably within free tier limits. 🎉

---

## 🛠️ Development

### Local Development Workflow

```bash
# Terminal 1: Start Supabase
npm run supabase:start

# Terminal 2: Start all frontends
npm run dev

# Terminal 3: Watch Edge Function logs
supabase functions logs --local
```

### Reset Database

```bash
npm run supabase:reset
```

### Deploy to Production

```bash
# Build all frontends
npm run build

# Deploy Edge Functions
npm run supabase:deploy

# Deploy frontends (use Vercel, Netlify, or similar)
# - web/admin/dist → admin.yourdomain.com
# - web/player/dist → player.yourdomain.com
# - web/kiosk/dist → kiosk.yourdomain.com
```

---

## 🔧 Configuration

### Player Settings (via Admin Console or SQL)

```sql
UPDATE player_settings SET
  loop = false,
  shuffle = true,
  volume = 75,
  freeplay = false,
  coin_per_song = 1,
  search_enabled = true,
  max_queue_size = 50,
  priority_queue_limit = 10
WHERE player_id = '00000000-0000-0000-0000-000000000001';
```

### Branding (Kiosk)

```sql
UPDATE player_settings SET
  branding = '{
    "name": "My Jukebox",
    "logo": "https://example.com/logo.png",
    "theme": "dark"
  }'::jsonb
WHERE player_id = '00000000-0000-0000-0000-000000000001';
```

---

## 🐛 Troubleshooting

### Player shows "offline" in Admin

**Solution**: Make sure Player window is open and running. Check browser console for errors.

### Kiosk requests fail with "Player offline"

**Solution**: Start Player window first. Player must send heartbeat to be considered online.

### Edge Functions not working

**Solution**: 
```bash
# Check function logs
supabase functions logs --local

# Redeploy
supabase functions deploy <function-name>
```

### Realtime not updating

**Solution**:
1. Check Supabase Realtime is enabled in dashboard
2. Verify RLS policies allow your auth level
3. Check browser console for Realtime connection errors

### "Insufficient credits" error in Kiosk

**Solution**: 
- Click "Insert Coin (Dev)" button
- Or enable free play: `UPDATE player_settings SET freeplay = true`

---

## 📚 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Database** | Supabase (PostgreSQL 15) |
| **Real-time** | Supabase Realtime (WebSockets) |
| **Backend** | Supabase Edge Functions (Deno) |
| **Auth** | Supabase Auth |
| **Frontend** | React 18 + Vite + TypeScript |
| **Styling** | Tailwind CSS |
| **Icons** | Lucide React |
| **Drag & Drop** | @dnd-kit |

---

## 🎯 Roadmap

- [ ] YouTube search integration via yt-dlp service
- [ ] WebSerial API for physical coin acceptor
- [ ] Voting system for priority queue
- [ ] DJ mode with crossfade
- [ ] Multi-room support
- [ ] Mobile apps (React Native)
- [ ] Analytics dashboard

---

## 📄 License

MIT

---

## 🙏 Credits

Built with ❤️ using:
- [Supabase](https://supabase.com) - Backend as a Service
- [Vite](https://vitejs.dev) - Next Generation Frontend Tooling
- [React](https://react.dev) - The library for web UIs
- [Tailwind CSS](https://tailwindcss.com) - Utility-first CSS

---

## 🎵 **Queue Management Implementation**

**📋 Complete Guide**: See [QUEUE_MANAGEMENT.md](./QUEUE_MANAGEMENT.md) for detailed implementation documentation

### Quick Reference

| Component | Location | Critical Setting |
|-----------|-----------|-----------------|
| **Debounce** | `web/shared/supabase-client.ts` | `800ms` (prevents race conditions) |
| **Current Item** | `web/admin/src/App.tsx` | `media_item_id` lookup (reliable) |
| **Queue Logic** | `queue_next()` RPC | Priority first, then normal/shuffle |
| **Locking** | All queue RPCs | `pg_advisory_xact_lock()` (atomic) |

### ⚠️ **DO NOT CHANGE**

1. **800ms debounce** - Critical for preventing race conditions
2. **Media ID lookup** - Reliable currentQueueItem detection  
3. **Priority queue logic** - Kiosk requests must play first
4. **PostgreSQL locks** - Prevents data corruption
5. **Server-first logic** - All business logic in database

### 🎯 **Recent Fix (Feb 2026)**

- **Issue**: Race condition caused `currentQueueItem` to become `undefined`
- **Cause**: Removed 800ms debounce from `subscribeToQueue`
- **Solution**: Restored debounce and reverted to original working logic
- **Status**: ✅ **FIXED** - Queue management is stable and reliable

---

## 📞 Support

For issues, feature requests, or questions:
- Open an issue on GitHub
- Check Supabase docs: [supabase.com/docs](https://supabase.com/docs)

---

**Made with Obie Jukebox v2 - Server-First, Real-Time, Free-Tier Safe 🎵**
