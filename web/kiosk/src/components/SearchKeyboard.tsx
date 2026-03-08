import React from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { KEYBOARD_ROWS, SPECIAL_KEYS } from "../../../shared/keyboard";

interface SearchKeyboardProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onKeyPress: (key: string) => void;
  title?: string;
  description?: string;
  includeKaraoke?: boolean;
  onIncludeKaraokeChange?: (checked: boolean) => void;
  searchSource?: 'youtube' | 'cloudflare';
  onSearchSourceChange?: (source: 'youtube' | 'cloudflare') => void;
  cloudflareEnabled?: boolean;
}

export const SearchKeyboard: React.FC<SearchKeyboardProps> = ({
  searchQuery,
  onSearchQueryChange,
  onKeyPress,
  title = "Search for Music",
  description = "Use the keyboard below to search for songs and add them to your playlist.",
  includeKaraoke = false,
  onIncludeKaraokeChange,
  searchSource = 'youtube',
  onSearchSourceChange,
  cloudflareEnabled = false,
}) => {
  console.log('[SearchKeyboard] Rendering with:', {
    includeKaraoke,
    hasCallback: !!onIncludeKaraokeChange
  });

  // Handle karaoke checkbox toggle
  const handleKaraokeToggle = (checked: boolean) => {
    if (!onIncludeKaraokeChange) return;

    // Don't modify the search query - just update the karaoke flag
    // The search backend will add " Lyric Video Karaoke" to the query when needed
    onIncludeKaraokeChange(checked);
  };

  return (
    <div className="h-full bg-slate-900/20 backdrop-blur-sm text-white p-3 sm:p-6 flex flex-col">
      <div className="mb-3 sm:mb-6">
        <h2 className="text-xl sm:text-3xl text-center text-amber-200">
          {title}
        </h2>
        <p className="text-center text-amber-300 text-sm sm:text-base">
          {description}
        </p>
      </div>

      <div className="mb-4 sm:mb-8">
        <Input
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder="Enter song or artist..."
          className="w-full h-12 sm:h-16 text-lg sm:text-2xl bg-slate-800/60 backdrop-blur border-slate-600 text-white placeholder-slate-400"
          readOnly
        />
      </div>

      {/* Source Toggle + Karaoke Checkbox */}
      <div className="mb-6 flex items-center justify-center gap-4 flex-wrap">
        {/* Source Toggle (YouTube / Cloudflare) */}
        {cloudflareEnabled && onSearchSourceChange && (
          <div className="flex items-center gap-2 bg-slate-800/40 p-3 rounded-lg border border-amber-500/30">
            <button
              onClick={() => onSearchSourceChange('youtube')}
              className={`px-4 py-2 rounded-lg text-sm sm:text-base font-bold transition-all ${
                searchSource === 'youtube'
                  ? 'bg-red-600 text-white border-2 border-red-400'
                  : 'bg-slate-700/60 text-slate-400 border-2 border-slate-600 hover:border-slate-400'
              }`}
            >
              YouTube
            </button>
            <button
              onClick={() => onSearchSourceChange('cloudflare')}
              className={`px-4 py-2 rounded-lg text-sm sm:text-base font-bold transition-all ${
                searchSource === 'cloudflare'
                  ? 'bg-orange-500 text-white border-2 border-orange-400'
                  : 'bg-slate-700/60 text-slate-400 border-2 border-slate-600 hover:border-slate-400'
              }`}
            >
              Library
            </button>
          </div>
        )}

        {/* Karaoke Checkbox */}
        {onIncludeKaraokeChange && (
          <div className="flex items-center justify-center gap-3 bg-slate-800/40 p-3 rounded-lg border border-amber-500/30">
            <label
              htmlFor="karaoke-checkbox"
              className="text-amber-200 text-base sm:text-xl font-semibold cursor-pointer select-none"
            >
              Show Karaoke Lyric Results
            </label>
            <input
              id="karaoke-checkbox"
              type="checkbox"
              checked={includeKaraoke}
              onChange={(e) => handleKaraokeToggle(e.target.checked)}
              className="w-6 h-6 sm:w-8 sm:h-8 cursor-pointer accent-amber-500"
            />
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col justify-center space-y-4">
        {KEYBOARD_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} className="flex justify-center gap-2">
            {row.map((key) => (
              <Button
                key={key}
                onClick={() => onKeyPress(key)}
                className="w-8 h-8 sm:w-20 sm:h-16 text-sm sm:text-xl font-bold bg-gradient-to-b from-slate-600 to-slate-700 hover:from-slate-500 hover:to-slate-600 border-2 border-slate-500 shadow-lg transform hover:scale-95 active:scale-90 transition-all duration-100"
                style={{
                  filter: "drop-shadow(-5px -5px 10px rgba(0,0,0,0.8))",
                }}
              >
                {key}
              </Button>
            ))}
          </div>
        ))}

        <div className="flex justify-center gap-1 sm:gap-2 mt-2 sm:mt-4">
          <Button
            onClick={() => onKeyPress(SPECIAL_KEYS.CLEAR)}
            className="w-16 h-8 sm:w-32 sm:h-16 text-sm sm:text-xl font-bold bg-gradient-to-b from-orange-600 to-orange-700 hover:from-orange-500 hover:to-orange-600 border-2 border-orange-500 shadow-lg transform hover:scale-95 active:scale-90 transition-all duration-100"
            style={{
              filter: "drop-shadow(-5px -5px 10px rgba(0,0,0,0.8))",
            }}
          >
            CLEAR
          </Button>
          <Button
            onClick={() => onKeyPress(SPECIAL_KEYS.SPACE)}
            className="w-20 h-8 sm:w-40 sm:h-16 text-sm sm:text-xl font-bold bg-gradient-to-b from-slate-600 to-slate-700 hover:from-slate-500 hover:to-slate-600 border-2 border-slate-500 shadow-lg transform hover:scale-95 active:scale-90 transition-all duration-100"
            style={{
              filter: "drop-shadow(-5px -5px 10px rgba(0,0,0,0.8))",
            }}
          >
            SPACE
          </Button>
          <Button
            onClick={() => onKeyPress(SPECIAL_KEYS.BACKSPACE)}
            className="w-16 h-8 sm:w-32 sm:h-16 text-sm sm:text-xl font-bold bg-gradient-to-b from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 border-2 border-red-500 shadow-lg transform hover:scale-95 active:scale-90 transition-all duration-100"
            style={{
              filter: "drop-shadow(-5px -5px 10px rgba(0,0,0,0.8))",
            }}
          >
            ⌫
          </Button>
          <Button
            onClick={() => onKeyPress(SPECIAL_KEYS.SEARCH)}
            disabled={!searchQuery.trim()}
            className="w-16 h-8 sm:w-32 sm:h-16 text-sm sm:text-xl font-bold bg-gradient-to-b from-green-600 to-green-700 hover:from-green-500 hover:to-green-600 border-2 border-green-500 shadow-lg transform hover:scale-95 active:scale-90 transition-all duration-100 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              filter: "drop-shadow(-5px -5px 10px rgba(0,0,0,0.8))",
            }}
          >
            SEARCH
          </Button>
        </div>
      </div>
    </div>
  );
};