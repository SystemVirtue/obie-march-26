-- Add per-denomination credit settings to player_settings.
-- coin_credits_dollar1: credits awarded when a $1 coin is inserted (serial char 'b')
-- coin_credits_dollar2: credits awarded when a $2 coin is inserted (serial char 'a')
alter table player_settings
  add column if not exists coin_credits_dollar1 integer not null default 1,
  add column if not exists coin_credits_dollar2 integer not null default 3;
