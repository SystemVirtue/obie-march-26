export interface SearchResult {
  id: string;
  title: string;
  artist?: string;
  channelTitle?: string;
  thumbnail: string;
  thumbnailUrl?: string;
  url: string;
  videoUrl?: string;
  duration?: number;
  officialScore?: number;
  /** Identifies result origin: 'youtube' (default) or 'cloudflare' (R2 bucket) */
  source?: 'youtube' | 'cloudflare';
}

export interface SearchInterfaceProps {
  isOpen: boolean;
  onClose: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchResults: SearchResult[];
  isSearching: boolean;
  showKeyboard: boolean;
  showSearchResults: boolean;
  onKeyboardInput: (key: string) => void;
  onVideoSelect: (video: SearchResult) => void;
  onBackToSearch: () => void;
  mode?: "FREEPLAY" | "PAID";
  credits?: number;
  onInsufficientCredits?: () => void;
  includeKaraoke?: boolean;
  onIncludeKaraokeChange?: (checked: boolean) => void;
  bypassCreditCheck?: boolean;
  searchSource?: 'youtube' | 'cloudflare';
  onSearchSourceChange?: (source: 'youtube' | 'cloudflare') => void;
  cloudflareEnabled?: boolean;
}