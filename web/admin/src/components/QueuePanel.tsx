import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { QueueItem, PlayerStatus } from '../types';
import { fmtDuration } from '../types';
import { Spinner, PanelHeader, Btn } from './ui';

function SortableQueueItem({ item, onRemove }: { item: QueueItem; onRemove: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (item as any).media_item as any;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderRadius: 11, padding: '9px 11px',
        background: 'rgba(255,255,255,0.025)', marginBottom: 4, border: '1px solid rgba(255,255,255,0.04)' }}>
        <button {...attributes} {...listeners} style={{ cursor: 'grab', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.2)', padding: 2, flexShrink: 0, fontSize: 14 }}>⋮⋮</button>
        {m?.thumbnail && <img src={m.thumbnail} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: 'cover', flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m?.title || 'Unknown'}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.38)' }}>{m?.artist || ''}</div>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>{fmtDuration(m?.duration)}</span>
        <button onClick={() => onRemove(item.id)} style={{ width: 26, height: 26, borderRadius: 7, background: 'rgba(239,68,68,0.12)', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 12 }}>✕</button>
      </div>
    </div>
  );
}

export function QueuePanel({ queue, status, onRemove, onReorder, onShuffle, isShuffling }: {
  queue: QueueItem[]; status: PlayerStatus | null;
  onRemove: (id: string) => void; onReorder: (e: DragEndEvent) => void;
  onShuffle: () => void; isShuffling: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const normalQ   = queue.filter(q => q.type === 'normal'   && q.media_item_id !== status?.current_media_id);
  const priorityQ = queue.filter(q => q.type === 'priority' && q.media_item_id !== status?.current_media_id);
  const totalCount = normalQ.length + priorityQ.length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Queue" subtitle={`${totalCount} song${totalCount !== 1 ? 's' : ''}`}
        actions={<Btn variant="accent" onClick={onShuffle} disabled={isShuffling}>{isShuffling ? <><Spinner size={12} /> Shuffling…</> : '🔀 Shuffle'}</Btn>}
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px' }}>

        {/* Priority Requests */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: '#60a5fa', textTransform: 'uppercase' }}>Priority Requests</span>
            {priorityQ.length > 0 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'rgba(59,130,246,0.2)', color: '#60a5fa' }}>{priorityQ.length}</span>
            )}
          </div>

          {priorityQ.length === 0 ? (
            <div style={{ borderRadius: 10, padding: '14px 16px', background: 'rgba(59,130,246,0.04)', border: '1px dashed rgba(59,130,246,0.15)', color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'center' }}>
              Empty
            </div>
          ) : (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            priorityQ.map(item => { const m = (item as any).media_item as any; return (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, borderRadius: 12, padding: '10px 12px', marginBottom: 6, background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.15)' }}>
                {m?.thumbnail && <img src={m.thumbnail} alt="" style={{ width: 36, height: 36, borderRadius: 7, objectFit: 'cover', flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m?.title || 'Unknown'}</div>
                  <div style={{ fontSize: 11, color: '#60a5fa', marginTop: 2 }}>{item.requested_by || 'Kiosk'}</div>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>{fmtDuration(m?.duration)}</span>
                <button onClick={() => onRemove(item.id)} style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(239,68,68,0.12)', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 12, flexShrink: 0 }}>✕</button>
              </div>
            );})
          )}
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', marginBottom: 20 }} />

        {/* Up Next */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>Up Next</span>
            {normalQ.length > 0 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.4)' }}>{normalQ.length}</span>
            )}
          </div>

          {normalQ.length === 0 ? (
            <div style={{ color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'center', paddingTop: 20 }}>Queue is empty</div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onReorder}>
              <SortableContext items={normalQ.map(i => i.id)} strategy={verticalListSortingStrategy}>
                {normalQ.map(item => <SortableQueueItem key={item.id} item={item} onRemove={onRemove} />)}
              </SortableContext>
            </DndContext>
          )}
        </div>

      </div>
    </div>
  );
}
