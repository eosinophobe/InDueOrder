import React, { useCallback, useEffect, useRef } from 'react';
import { Queue, renderWidget, usePlugin, useSyncedStorageState } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

function toEpochMs(value?: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function isForgot(nextRepetitionTime?: number | null): boolean {
  const epochMs = toEpochMs(nextRepetitionTime);
  if (epochMs === null) {
    return false;
  }

  const diff = epochMs - Date.now();
  return diff >= 0 && diff <= 65_000;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

type CardBaseline = {
  cardId: string;
  lastRep: number | null;
  nextRep: number | null;
  loadedAt: number;
};

class QueueErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || 'Queue failed to render.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Queue render failed: {this.state.message}
        </div>
      );
    }

    return this.props.children;
  }
}

const QueueWindowWidget = () => {
  const plugin = usePlugin();
  const [cardIdsJson] = useSyncedStorageState<string>('manual-queue-card-ids-json', '[]');
  const [totalCountText] = useSyncedStorageState<string>('manual-queue-total-count', '0');
  const [forgotCardIds] = useSyncedStorageState<string>('queue-forgot-cards-json', '[]');

  const advanceLockRef = useRef(false);
  const baselineRef = useRef<CardBaseline | null>(null);
  const pollInFlightRef = useRef(false);
  const repetitionHandledForCardRef = useRef(false);
  const forgotReinsertionTimersRef = useRef<Map<string, number>>(new Map());

  const cardIds = parseStringArray(cardIdsJson);
  const forgotCards = parseStringArray(forgotCardIds);
  const totalCount = Number.parseInt(totalCountText, 10);
  const hadQueuedCards = Number.isFinite(totalCount) && totalCount > 0;
  const activeCardId = cardIds[0] ?? null;

  useEffect(() => {
    const pushHeartbeat = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      void plugin.storage.setSynced('custom-queue-popup-heartbeat', String(Date.now()));
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
      void plugin.storage.setSynced('custom-queue-remaining-count', '0');
      void plugin.storage.setSynced('custom-queue-css-enabled', 'false');
      forgotReinsertionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      forgotReinsertionTimersRef.current.clear();
    };
  }, [plugin]);

  useEffect(() => {
    void plugin.storage.setSynced('custom-queue-remaining-count', String(cardIds.length));
  }, [cardIds.length, plugin]);

  useEffect(() => {
    pollInFlightRef.current = false;
    repetitionHandledForCardRef.current = false;
    baselineRef.current = null;
  }, [cardIdsJson]);

  useEffect(() => {
    if (!activeCardId) {
      baselineRef.current = null;
      return;
    }

    let cancelled = false;

    const loadBaseline = async () => {
      const card = await plugin.card.findOne(activeCardId);
      if (!card || cancelled) {
        return;
      }

      baselineRef.current = {
        cardId: activeCardId,
        lastRep: typeof card.lastRepetitionTime === 'number' ? card.lastRepetitionTime : null,
        nextRep: typeof card.nextRepetitionTime === 'number' ? card.nextRepetitionTime : null,
        loadedAt: Date.now(),
      };
    };

    void loadBaseline();

    return () => {
      cancelled = true;
    };
  }, [activeCardId, plugin]);

  const scheduleForgotCardReinsertion = useCallback(async (completedCardId: string) => {
    const storedForgotCards = parseStringArray((await plugin.storage.getSynced<string>('queue-forgot-cards-json')) ?? '[]');
    if (!storedForgotCards.includes(completedCardId)) {
      await plugin.storage.setSynced('queue-forgot-cards-json', JSON.stringify([...storedForgotCards, completedCardId]));
    }

    const existingTimer = forgotReinsertionTimersRef.current.get(completedCardId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(async () => {
      forgotReinsertionTimersRef.current.delete(completedCardId);
      const queueList = parseStringArray((await plugin.storage.getSynced<string>('manual-queue-card-ids-json')) ?? '[]');
      const withoutCard = queueList.filter((id) => id !== completedCardId);
      withoutCard.splice(Math.min(4, withoutCard.length), 0, completedCardId);
      await plugin.storage.setSynced('manual-queue-card-ids-json', JSON.stringify(withoutCard));
    }, 50);

    forgotReinsertionTimersRef.current.set(completedCardId, timer);
  }, [plugin]);

  const advanceToNextCard = useCallback(async (completedCardId: string) => {
    if (advanceLockRef.current) {
      return;
    }

    advanceLockRef.current = true;
    repetitionHandledForCardRef.current = true;

    try {
      const latestIds = parseStringArray((await plugin.storage.getSynced<string>('manual-queue-card-ids-json')) ?? '[]');
      const nextIds = latestIds.filter((id) => id !== completedCardId);
      await plugin.storage.setSynced('manual-queue-card-ids-json', JSON.stringify(nextIds));

      if (nextIds.length === 0) {
        await plugin.storage.setSynced('custom-queue-completion-popup-at', String(Date.now() + 50));
        void plugin.widget.closePopup();
      }
    } finally {
      window.setTimeout(() => {
        advanceLockRef.current = false;
      }, 100);
    }
  }, [plugin]);

  useEffect(() => {
    if (!activeCardId) {
      return;
    }

    const watcher = window.setInterval(() => {
      if (advanceLockRef.current || repetitionHandledForCardRef.current || pollInFlightRef.current) {
        return;
      }

      const baseline = baselineRef.current;
      if (!baseline || baseline.cardId !== activeCardId) {
        return;
      }

      pollInFlightRef.current = true;
      void (async () => {
        try {
          const card = await plugin.card.findOne(activeCardId);
          if (!card) {
            return;
          }

          const currentLastRep = typeof card.lastRepetitionTime === 'number' ? card.lastRepetitionTime : null;
          const currentNextRep = typeof card.nextRepetitionTime === 'number' ? card.nextRepetitionTime : null;
          const lastRepChanged = baseline.lastRep !== currentLastRep;
          const nextRepChanged = baseline.nextRep !== currentNextRep;

          if (!lastRepChanged && !nextRepChanged) {
            return;
          }

          const allowNextRepOnly = nextRepChanged && Date.now() - baseline.loadedAt >= 150;
          if (!lastRepChanged && !allowNextRepOnly) {
            return;
          }

          if (isForgot(currentNextRep)) {
            await scheduleForgotCardReinsertion(activeCardId);
          }

          await advanceToNextCard(activeCardId);
        } finally {
          pollInFlightRef.current = false;
        }
      })();
    }, 50);

    return () => {
      window.clearInterval(watcher);
      pollInFlightRef.current = false;
    };
  }, [activeCardId, advanceToNextCard, scheduleForgotCardReinsertion]);

  return (
    <div>
      {cardIds.length === 0 ? (
        hadQueuedCards ? null : (
          <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
            No cards found. Use Start Queue in the Custom Queue sidebar.
          </div>
        )
      ) : (
        <QueueErrorBoundary>
          <Queue
            key={`single-${activeCardId}-${cardIds.length}`}
            cardIds={activeCardId ? [activeCardId] : []}
            width="100%"
            height="100%"
          />
        </QueueErrorBoundary>
      )}

      {forgotCards.length > 0 ? (
        <div className="absolute bottom-0 left-0 right-0 border-t border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-800">
          <div className="font-semibold">Forgot cards ({forgotCards.length}):</div>
          <div className="break-words">{forgotCards.map((id) => id.slice(0, 8)).join(', ')}</div>
        </div>
      ) : null}
    </div>
  );
};

renderWidget(QueueWindowWidget);
