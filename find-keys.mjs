#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';

// Option 1: Try to get from supabase status
try {
  const status = JSON.parse(execSync('supabase status --json', { encoding: 'utf-8' }));
  console.log('Supabase Status:');
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
} catch (error) {
  console.error('Could not fetch Supabase status:', error.message);
}

// Option 2: Check .env files
const envFiles = [
  '.env.local',
  '.env',
  '.env.production',
  'web/player/.env.local',
  'web/admin/.env.local',
  'web/kiosk/.env.local'
];

for (const file of envFiles) {
  if (fs.existsSync(file)) {
    console.log(`\nFound ${file}:`);
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(l => l.includes('SUPABASE'));
    lines.forEach(l => {
      if (l.includes('KEY') || l.includes('URL')) {
        console.log(l.replace(/=.+$/, '=***'));
      }
    });
  }
}

process.exit(1);
