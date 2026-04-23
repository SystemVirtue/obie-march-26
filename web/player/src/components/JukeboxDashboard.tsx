import { normalizeJukeboxSlug } from '@shared/jukebox-utils';

export function JukeboxDashboard() {
  const handleEnterJukebox = () => {
    const entered = window.prompt('Enter Jukebox Name (e.g. OBIE):');
    const slug = normalizeJukeboxSlug(entered);
    if (!slug) return;
    window.location.assign(`/${slug}`);
  };

  return (
    <div className="relative w-screen h-screen bg-black flex items-center justify-center text-white">
      <div className="text-center max-w-md px-6">
        <div className="text-3xl font-bold mb-4">Jukebox Name Required</div>
        <div className="text-gray-300 mb-6">Enter a jukebox name to start viewing</div>
        <button
          onClick={handleEnterJukebox}
          className="px-5 py-3 rounded-lg bg-white text-black font-semibold hover:bg-gray-200"
        >
          Enter Jukebox Name
        </button>
        <div className="text-gray-500 mt-4 text-sm">
          Or enter a jukebox name directly in the URL (e.g., /OBIE)
        </div>
      </div>
    </div>
  );
}
