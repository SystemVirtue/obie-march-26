import { cleanDisplayText } from '../../../shared/media-utils';
import type { QueueItem } from '../../../shared/supabase-client';

interface QueueMarqueeProps {
  queue: QueueItem[];
}

export function QueueMarquee({ queue }: QueueMarqueeProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-black/90 border-t border-yellow-400/50 py-3 backdrop-blur-sm">
      <div className="mx-auto max-w-full overflow-hidden">
        <div className="marquee">
          <div className="marquee-track flex items-center whitespace-nowrap gap-8 text-yellow-400 font-semibold text-sm drop-shadow-lg">
            {queue.length > 0 ? (
              <>
                {queue.map((q) => (
                  <QueueEntry key={`${q.id}-1`} item={q} />
                ))}
                {/* Duplicate content for seamless loop */}
                {queue.map((q) => (
                  <QueueEntry key={`${q.id}-2`} item={q} />
                ))}
              </>
            ) : (
              <div className="px-6 drop-shadow-lg">Coming Up: No items</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function QueueEntry({ item }: { item: QueueItem }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const media = item.media_item as any;
  return (
    <div className="px-6 flex items-center gap-2">
      {item.type === 'priority' && <span className="text-red-400 drop-shadow-lg">★</span>}
      <span>
        {cleanDisplayText(media?.title) || 'Untitled'} -{' '}
        <span className="text-gray-300 drop-shadow-lg">
          {cleanDisplayText(media?.artist) || 'Unknown'}
        </span>
      </span>
    </div>
  );
}
