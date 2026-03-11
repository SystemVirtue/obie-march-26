import { cleanDisplayText } from '../../../shared/media-utils';
import { type SearchResult } from '../../../shared/types';

interface ConfirmationDialogProps {
  selectedResult: SearchResult;
  freeplay: boolean;
  isConfirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmationDialog({
  selectedResult,
  freeplay,
  isConfirming,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
      <div className="bg-yellow-50 text-black rounded-lg p-6 w-[520px]">
        <div className="text-lg font-bold mb-2">Add song to Playlist?</div>
        <div className="text-sm text-gray-700 mb-4">Confirm adding this song to your playlist for playback.</div>
        <div className="flex gap-4 items-center">
          {selectedResult.thumbnail ? (
            <img src={selectedResult.thumbnail} className="w-20 h-20 object-cover rounded" />
          ) : (
            <div className="w-20 h-20 rounded bg-black flex-shrink-0" />
          )}
          <div>
            <div className="font-semibold">{cleanDisplayText(selectedResult.title)}</div>
            <div className="text-sm text-gray-700">{cleanDisplayText(selectedResult.artist)}</div>
            <div className="text-sm text-gray-700 mt-2">{freeplay ? 'Cost: FREE' : 'Cost: 1 Credit'}</div>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onCancel} className="px-4 py-2 bg-red-100 rounded">No</button>
          <button
            onClick={onConfirm}
            disabled={isConfirming}
            className={`px-4 py-2 rounded ${isConfirming ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'} text-white`}
          >
            {isConfirming ? 'Adding...' : 'Yes'}
          </button>
        </div>
      </div>
    </div>
  );
}
