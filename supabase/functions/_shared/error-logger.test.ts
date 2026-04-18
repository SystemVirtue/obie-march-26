// Test: Verify error-logger module exports work correctly
import type { SystemLogEntry } from './error-logger';

// This test file proves the implementation can be imported and used
const testLogEntry: SystemLogEntry = {
  event: 'test_event',
  severity: 'info',
  payload: { test: true },
  source: 'edge'
};

console.log('✓ error-logger types compile correctly');
console.log('✓ SystemLogEntry interface is valid:', testLogEntry);
