import { useRef, useState } from 'react';
import { exportReviewRankingData } from './useReviewRankingCapture';

export function ReviewRankingExportButton({ workspaceId }: { workspaceId: string }) {
  const inProgress = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  const exportData = async () => {
    if (inProgress.current) return;
    inProgress.current = true;
    setSaving(true);
    setMessage('');
    setFailed(false);
    try {
      const result = await exportReviewRankingData(workspaceId);
      setFailed(result.status === 'error');
      setMessage(result.status === 'saved' ? 'Ranking data saved.'
        : result.status === 'error' ? result.message : 'Export canceled.');
    } catch {
      setFailed(true);
      setMessage('Could not export ranking data. Try again.');
    } finally {
      inProgress.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="h-7 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted/40 disabled:opacity-50"
        title="Save ranking data stored on this device, for up to 30 days"
        disabled={saving}
        onClick={() => { void exportData(); }}
      >
        {saving ? 'Exporting…' : 'Export ranking data'}
      </button>
      {message && <span role={failed ? 'alert' : 'status'} className="text-xs">{message}</span>}
    </>
  );
}
