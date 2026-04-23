import React, { useEffect, useState } from 'react';
import { usePlugin, renderWidget } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

const QueueCompletionWidget = () => {
  const plugin = usePlugin();
  const [forgottenCount, setForgottenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // Set the one-time clearance flag when queue_completion opens
        await plugin.storage.setSynced('queue-completion-clear-forgot-list-on-close', 'true');
        const raw = await plugin.storage.getSynced<string>('queue-forgot-cards-json');
        let count = 0;
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            count = arr.filter((v) => typeof v === 'string').length;
          }
        }
        setForgottenCount(count);
      } catch (e) {
        setError('Could not load forgotten cards.');
      } finally {
        setLoading(false);
      }
    })();

    const pushHeartbeat = () => {
      if (document.visibilityState !== 'visible') return;

      const now = String(Date.now());

      void plugin.storage.setSynced('custom-queue-popup-heartbeat', now);
      void plugin.storage.setSynced('custom-queue-completion-popup-heartbeat', String(Date.now()));
    };

    pushHeartbeat();
    void plugin.storage.setSynced('custom-queue-css-enabled', 'true');

    const cssRetryTimer = window.setTimeout(() => {
      void plugin.storage.setSynced('custom-queue-css-enabled', 'true');
    }, 500);

    const heartbeatInterval = window.setInterval(pushHeartbeat, 1000);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void plugin.storage.setSynced('custom-queue-popup-heartbeat', '0');
        void plugin.storage.setSynced('custom-queue-completion-popup-heartbeat', '0');
        return;
      }

      pushHeartbeat();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearTimeout(cssRetryTimer);
      window.clearInterval(heartbeatInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void plugin.storage.setSynced('custom-queue-popup-heartbeat', '0');
      void plugin.storage.setSynced('custom-queue-completion-popup-heartbeat', '0');
      void plugin.storage.setSynced('custom-queue-css-enabled', 'false');
    };
  }, [plugin]);

  const handleReviewForgotten = async () => {
    setLoading(true);
    setError('');
    try {
      const raw = await plugin.storage.getSynced<string>('queue-forgot-cards-json');
      let arr: string[] = [];
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          arr = parsed.filter((v) => typeof v === 'string');
        }
      }
      if (arr.length === 0) {
        setError('No forgotten cards to review.');
        setLoading(false);
        return;
      }
      await plugin.storage.setSynced('manual-queue-card-ids-json', JSON.stringify(arr));
      await plugin.storage.setSynced('manual-queue-total-count', String(arr.length));
      await plugin.storage.setSynced('queue-forgot-cards-json', '[]');
      await plugin.storage.setSynced('queue-completion-clear-forgot-list-on-close', '');
      await plugin.widget.openPopup('queue_content');
    } catch (e) {
      setError('Failed to start review.');
      setLoading(false);
    }
  };

  const handleNo = async () => {
    setLoading(true);
    setError('');
    try {
      await plugin.storage.setSynced('queue-forgot-cards-json', '[]');
      await plugin.storage.setSynced('queue-completion-clear-forgot-list-on-close', '');
      await plugin.widget.closePopup();
    } catch (e) {
      setError('Failed to close popup.');
      setLoading(false);
    }
  };

  return (
    <div className="h-full w-full bg-white text-slate-900" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <div className="w-full flex flex-col items-center justify-center p-6" style={{ transform: 'translateY(-100px)' }}>
        <div className="text-center">
          <div className="text-2xl font-semibold mb-4">Queue completed</div>
          {loading ? (
            <div className="text-slate-500 text-sm">Loading...</div>
          ) : error ? (
            <div className="text-red-600 text-sm mb-2">{error}</div>
          ) : forgottenCount > 0 ? (
            <>
              <div className="mb-3 text-lg text-yellow-800 font-medium">
                You have marked {forgottenCount} card{forgottenCount === 1 ? '' : 's'} as forgot.<br />
                Would you like to review {forgottenCount === 1 ? 'that one' : 'them'} now?
              </div>
              <div className="flex flex-col items-center gap-2">
                <button
                  className="rounded-md px-3 py-2 text-sm font-medium"
                  style={{ backgroundColor: '#104862', color: 'white', opacity: 1, visibility: 'visible', pointerEvents: 'auto' }}
                  onClick={handleReviewForgotten}
                  disabled={loading}
                  type="button"
                >
                  Yes, review forgotten card{forgottenCount === 1 ? '' : 's'}
                </button>
                <button
                  className="rounded-md px-3 py-2 text-sm font-medium"
                  style={{ backgroundColor: '#104862', color: 'white', opacity: 1, visibility: 'visible', pointerEvents: 'auto' }}
                  onClick={handleNo}
                  disabled={loading}
                  type="button"
                >
                  No, close queue
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="text-slate-700 text-lg">All done!</div>
              <button
                className="rounded-md px-3 py-2 text-sm font-medium"
                style={{ backgroundColor: '#104862', color: 'white', opacity: 1, visibility: 'visible', pointerEvents: 'auto' }}
                onClick={handleNo}
                disabled={loading}
                type="button"
              >
                Close queue
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

renderWidget(QueueCompletionWidget);
