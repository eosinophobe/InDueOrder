import React, { useEffect, useRef, useState } from 'react';
import { AppEvents, Queue, renderWidget, usePlugin, useSyncedStorageState } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

function toEpochMs(val?: number | null): number | null {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  return val < 1_000_000_000_000 ? val * 1000 : val;
}

function isForgot(nextRepetitionTime?: number | null): boolean {
  const ms = toEpochMs(nextRepetitionTime);
  if (ms === null) return false;
  const diff = ms - Date.now();
  return diff >= 0 && diff <= 65_000;
}

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
  const [shouldRenderQueue, setShouldRenderQueue] = useState(false);
  const [queueRenderKey, setQueueRenderKey] = useState(0);
  const [remainingCardIds, setRemainingCardIds] = useState<string[]>([]);
  const [showTransitionMask, setShowTransitionMask] = useState(false);
  const [isAwaitingConfirmation, setIsAwaitingConfirmation] = useState(false);

  const advanceLockRef = useRef(false);
  const repetitionHandledForCardRef = useRef(false);
  const pairBaselineRef = useRef<Map<string, { lastRep: number | null; nextRep: number | null }>>(new Map());
  const answerInputHideRef = useRef(false);
  const remainingCardIdsRef = useRef<string[]>([]);
  const activeCardIdRef = useRef<string | null>(null);
  const currentPairRef = useRef<{ desired: string | null; secondary: string | null }>({ desired: null, secondary: null });
  const remountAttemptRef = useRef(0);
  const remountLockRef = useRef(false);
  const remountCooldownRef = useRef(0);
  const forgotReinsertiontTimersRef = useRef<Map<string, number>>(new Map());

  const [forgotCardIds, setForgotCardIds] = useSyncedStorageState<string>('queue-forgot-cards-json', '[]');
  
  let cardIds: string[] = [];
  try {
    const parsed = JSON.parse(cardIdsJson);
    if (Array.isArray(parsed)) {
      cardIds = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    cardIds = [];
  }
  
  let forgotCards: string[] = [];
  try {
    const parsed = JSON.parse(forgotCardIds);
    if (Array.isArray(parsed)) {
      forgotCards = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    forgotCards = [];
  }

  const totalCount = Number.parseInt(totalCountText, 10);
  const hadQueuedCards = Number.isFinite(totalCount) && totalCount > 0;

  const appendPersistentDebugEvent = async (message: string) => {
    const now = new Date();
    const timestamp = now.toLocaleTimeString();
    const nextLine = `${timestamp} ${message}`;

    let existing: string[] = [];
    try {
      const raw = await plugin.storage.getSynced<string>('queue-debug-events-json');
      const parsed = JSON.parse(raw ?? '[]');
      if (Array.isArray(parsed)) {
        existing = parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch {
      existing = [];
    }

    const nextEvents = [...existing, nextLine].slice(-18);
    await plugin.storage.setSynced('queue-debug-events-json', JSON.stringify(nextEvents));
    await plugin.storage.setSynced('queue-debug-last-message', nextLine);
  };

  const incrementPersistentCounter = async (key: string) => {
    const raw = await plugin.storage.getSynced<string>(key);
    const current = Number.parseInt(raw ?? '0', 10);
    const next = Number.isFinite(current) ? current + 1 : 1;
    await plugin.storage.setSynced(key, String(next));
    return next;
  };

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
      // Clear any pending forgot reinsertion timers
      forgotReinsertiontTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      forgotReinsertiontTimersRef.current.clear();
    };
  }, [plugin]);

  useEffect(() => {
    void plugin.storage.setSynced('custom-queue-remaining-count', String(remainingCardIds.length));
  }, [plugin, remainingCardIds.length]);

  useEffect(() => {
    void (async () => {
      const mountCount = await incrementPersistentCounter('queue-debug-popup-mount-count');
      await appendPersistentDebugEvent(`popup mounted #${mountCount}`);
    })();
  }, []);

  useEffect(() => {
    void plugin.storage.setSynced('queue-debug-render-key', String(queueRenderKey));
  }, [plugin, queueRenderKey]);

  useEffect(() => {
    setRemainingCardIds(cardIds);
    remainingCardIdsRef.current = cardIds;
    activeCardIdRef.current = cardIds[0] ?? null;
    setShouldRenderQueue(false);
    setShowTransitionMask(false);
    repetitionHandledForCardRef.current = false;
    pairBaselineRef.current = new Map();
    answerInputHideRef.current = false;

    if (cardIds.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setShouldRenderQueue(true);
      setIsAwaitingConfirmation(true);
    }, 40);

    return () => {
      window.clearTimeout(timer);
    };
  }, [cardIds.length, cardIdsJson]);

  useEffect(() => {
    repetitionHandledForCardRef.current = false;
    pairBaselineRef.current = new Map();

    const activeCardId = remainingCardIds[0];
    const nextCardId = remainingCardIds[1];
    remainingCardIdsRef.current = remainingCardIds;
    activeCardIdRef.current = activeCardId ?? null;
    if (!activeCardId) {
      return;
    }

    let cancelled = false;

    const loadBaseline = async () => {
      const ids = [activeCardId, nextCardId].filter((value): value is string => typeof value === 'string');
      const uniqueIds = Array.from(new Set(ids));
      const baseline = new Map<string, { lastRep: number | null; nextRep: number | null }>();

      for (const id of uniqueIds) {
        const card = await plugin.card.findOne(id);
        if (!card) {
          continue;
        }

        baseline.set(id, {
          lastRep: typeof card.lastRepetitionTime === 'number' ? card.lastRepetitionTime : null,
          nextRep: typeof card.nextRepetitionTime === 'number' ? card.nextRepetitionTime : null,
        });
      }

      if (cancelled) {
        return;
      }

      pairBaselineRef.current = baseline;
    };

    void loadBaseline();

    return () => {
      cancelled = true;
    };
  }, [plugin, remainingCardIds]);

  const advanceToNextCard = async () => {
    if (advanceLockRef.current) {
      return;
    }

    advanceLockRef.current = true;
    repetitionHandledForCardRef.current = true;

    try {
      let latestIds: string[] = [];
      try {
        const parsed = JSON.parse(cardIdsJson);
        if (Array.isArray(parsed)) {
          latestIds = parsed.filter((value): value is string => typeof value === 'string');
        }
      } catch {
        latestIds = [];
      }

      const nextIds = latestIds.slice(1);
      await plugin.storage.setSynced('manual-queue-card-ids-json', JSON.stringify(nextIds));

      if (nextIds.length === 0) {
        setRemainingCardIds([]);
        setShouldRenderQueue(false);
        setShowTransitionMask(false);
        await plugin.storage.setSynced('custom-queue-completion-popup-at', String(Date.now() + 50));
        void plugin.widget.closePopup();
        window.setTimeout(() => {
          advanceLockRef.current = false;
        }, 100);
        return;
      }

      setRemainingCardIds(nextIds);
      setShouldRenderQueue(true);
      setIsAwaitingConfirmation(true);
      window.setTimeout(() => {
        advanceLockRef.current = false;
      }, 20);
    } catch {
      setShowTransitionMask(false);
      advanceLockRef.current = false;
    }
  };

  const activeCardId = remainingCardIds[0] ?? null;
  const secondaryCardId = null;
  const queueCardIdsForRender = activeCardId
    ? [activeCardId]
    : [];

  useEffect(() => {
    currentPairRef.current = {
      desired: activeCardId,
      secondary: secondaryCardId,
    };
    remountAttemptRef.current = 0;
    remountCooldownRef.current = 0;
  }, [activeCardId, secondaryCardId]);

  useEffect(() => {
    if (!shouldRenderQueue || !activeCardId) {
      return;
    }

    let confirmationSettled = false;
    let confirmationFallback: number | undefined;
    let secondarySeenAt: number | null = null;

    const settleConfirmation = (reason: string) => {
      if (confirmationSettled) {
        return;
      }

      confirmationSettled = true;
      if (confirmationFallback !== undefined) {
        window.clearTimeout(confirmationFallback);
      }

      setIsAwaitingConfirmation(false);
      setShowTransitionMask(false);
      void appendPersistentDebugEvent(reason);
    };

    const remountForMismatch = () => {
      if (remountLockRef.current) {
        return;
      }

      const now = Date.now();
      if (now < remountCooldownRef.current) {
        return;
      }

      if (remountAttemptRef.current >= 6) {
        setIsAwaitingConfirmation(false);
        return;
      }

      remountLockRef.current = true;
      remountAttemptRef.current += 1;
      void (async () => {
        const mismatchCount = await incrementPersistentCounter('queue-debug-mismatch-remount-count');
        await appendPersistentDebugEvent(`mismatch remount #${mismatchCount} (attempt=${remountAttemptRef.current})`);
      })();
      remountCooldownRef.current = now + 200;
      setIsAwaitingConfirmation(true);
      setQueueRenderKey((prev) => prev + 1);
      window.setTimeout(() => {
        remountLockRef.current = false;
      }, 80);
    };

    let cancelled = false;

    const checkCurrentCard = async () => {
      const desired = currentPairRef.current.desired;
      const secondary = currentPairRef.current.secondary;
      if (!desired) {
        settleConfirmation('no desired card; closing confirmation');
        setShouldRenderQueue(false);
        return;
      }

      if (!secondary) {
        settleConfirmation('single-card queue; confirmation done');
        setShouldRenderQueue(true);
        return;
      }

      const card = await plugin.queue.getCurrentCard();
      if (cancelled) {
        return;
      }

      const currentCardId = card?._id ?? null;

      if (!currentCardId) {
        return;
      }

      if (currentCardId === desired) {
        secondarySeenAt = null;
        remountAttemptRef.current = 0;
        remountCooldownRef.current = 0;
        setShouldRenderQueue(true);
        settleConfirmation(`desired card confirmed (${desired.slice(0, 8)})`);
        return;
      }

      if (currentCardId === secondary) {
        if (secondarySeenAt === null) {
          secondarySeenAt = Date.now();
          void appendPersistentDebugEvent(`secondary card detected (${secondary.slice(0, 8)}), waiting 30ms before remount`);
          return;
        }

        if (Date.now() - secondarySeenAt < 30) {
          return;
        }

        remountForMismatch();
        secondarySeenAt = null;
        return;
      }

      secondarySeenAt = null;
    };

    const handleQueueLoad = (_payload: unknown) => {
      void checkCurrentCard();
    };

    plugin.event.addListener('queue.load-card', 'custom-queue-force-first-load', handleQueueLoad);
    plugin.event.addListener(AppEvents.QueueEnter, 'custom-queue-force-first-enter', handleQueueLoad);
    plugin.event.addListener(AppEvents.RevealAnswer, 'custom-queue-force-first-reveal', handleQueueLoad);

    const pollTimers = [60, 120, 200, 320, 500, 750, 1050].map((delay) =>
      window.setTimeout(() => void checkCurrentCard(), delay)
    );

    confirmationFallback = window.setTimeout(() => {
      if (!cancelled) {
        settleConfirmation('confirmation timeout fallback fired');
      }
    }, 1400);

    return () => {
      cancelled = true;
      plugin.event.removeListener('queue.load-card', 'custom-queue-force-first-load', handleQueueLoad);
      plugin.event.removeListener(AppEvents.QueueEnter, 'custom-queue-force-first-enter', handleQueueLoad);
      plugin.event.removeListener(AppEvents.RevealAnswer, 'custom-queue-force-first-reveal', handleQueueLoad);
      pollTimers.forEach((t) => window.clearTimeout(t));
      if (confirmationFallback !== undefined) {
        window.clearTimeout(confirmationFallback);
      }
    };
  }, [activeCardId, plugin, secondaryCardId, shouldRenderQueue]);

  useEffect(() => {
    if (!activeCardId || !shouldRenderQueue) {
      return;
    }

    const answerButtonTerms = ['forgot', 'hard', 'good', 'easy', 'again', 'recalled', 'partially'];

    const onClick = (event: MouseEvent) => {
      if (answerInputHideRef.current) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const button = target?.closest('button');
      const text = (button?.textContent || '').trim().toLowerCase();
      if (!text) {
        return;
      }

      if (!answerButtonTerms.some((term) => text.includes(term))) {
        return;
      }

      answerInputHideRef.current = true;
      setShowTransitionMask(true);
      setIsAwaitingConfirmation(true);
      void appendPersistentDebugEvent(`answer click detected (${text})`);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (answerInputHideRef.current) {
        return;
      }

      const isAnswerKey =
        event.key === '1'
        || event.key === '2'
        || event.key === '3'
        || event.key === '4'
        || event.code === 'Digit1'
        || event.code === 'Digit2'
        || event.code === 'Digit3'
        || event.code === 'Digit4'
        || event.code === 'Numpad1'
        || event.code === 'Numpad2'
        || event.code === 'Numpad3'
        || event.code === 'Numpad4';

      if (!isAnswerKey) {
        return;
      }

      answerInputHideRef.current = true;
      setShowTransitionMask(true);
      setIsAwaitingConfirmation(true);
      void appendPersistentDebugEvent(`answer key detected (${event.key || event.code})`);
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);

    const watcher = window.setInterval(() => {
      if (advanceLockRef.current || repetitionHandledForCardRef.current) {
        return;
      }

      const baselineMap = pairBaselineRef.current;
      if (baselineMap.size === 0) {
        return;
      }

      void (async () => {
        for (const [cardId, baseline] of baselineMap.entries()) {
          const card = await plugin.card.findOne(cardId);
          if (!card) {
            continue;
          }

          const currentLastRep = typeof card.lastRepetitionTime === 'number' ? card.lastRepetitionTime : null;
          const currentNextRep = typeof card.nextRepetitionTime === 'number' ? card.nextRepetitionTime : null;
          const lastRepChanged = baseline.lastRep !== currentLastRep;
          const nextRepChanged = baseline.nextRep !== currentNextRep;
          if (!lastRepChanged && !nextRepChanged) {
            continue;
          }

          // Check if this card was marked forgot
          if (isForgot(currentNextRep)) {
            void appendPersistentDebugEvent(`forgot detected for ${cardId.slice(0, 8)}`);
            // Capture to forgot list
            let forgotList: string[] = [];
            try {
              const raw = await plugin.storage.getSynced<string>('queue-forgot-cards-json');
              const parsed = JSON.parse(raw ?? '[]');
              if (Array.isArray(parsed)) {
                forgotList = parsed.filter((value): value is string => typeof value === 'string');
              }
            } catch {
              forgotList = [];
            }
            if (!forgotList.includes(cardId)) {
              forgotList.push(cardId);
              await plugin.storage.setSynced('queue-forgot-cards-json', JSON.stringify(forgotList));
            }

            // Start 3-second timer to reinsertion at index 4
            const existingTimer = forgotReinsertiontTimersRef.current.get(cardId);
            if (existingTimer) {
              window.clearTimeout(existingTimer);
            }
            const timer = window.setTimeout(async () => {
              forgotReinsertiontTimersRef.current.delete(cardId);
              let queueList: string[] = [];
              try {
                const raw = await plugin.storage.getSynced<string>('manual-queue-card-ids-json');
                const parsed = JSON.parse(raw ?? '[]');
                if (Array.isArray(parsed)) {
                  queueList = parsed.filter((value): value is string => typeof value === 'string');
                }
              } catch {
                queueList = [];
              }
              const without = queueList.filter((id) => id !== cardId);
              without.splice(Math.min(4, without.length), 0, cardId);
              await plugin.storage.setSynced('manual-queue-card-ids-json', JSON.stringify(without));
            }, 50);
            forgotReinsertiontTimersRef.current.set(cardId, timer);
          }

          repetitionHandledForCardRef.current = true;
          void advanceToNextCard();
          return;
        }
      })();
    }, 10);

    return () => {
      window.clearInterval(watcher);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      answerInputHideRef.current = false;
    };
  }, [activeCardId, plugin, shouldRenderQueue]);

  return (
    <div>
      {/* Exit button removed as requested */}
      {cardIds.length === 0 ? (
        hadQueuedCards ? null : (
        <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
          No cards found. Use Start Queue in the Custom Queue sidebar.
        </div>
        )
      ) : remainingCardIds.length === 0 ? (
        null
      ) : (
        <div className={isAwaitingConfirmation ? 'pointer-events-none' : ''}>
          <QueueErrorBoundary>
            <Queue
              key={`single-${queueRenderKey}-${activeCardId}`}
              cardIds={queueCardIdsForRender}
              width="100%"
              height="100%"
            />
          </QueueErrorBoundary>
        </div>
      )}

      {showTransitionMask ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-white">
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
            Loading next card...
          </div>
        </div>
      ) : null}

      {forgotCards.length > 0 ? (
        <div className="absolute bottom-0 left-0 right-0 bg-yellow-50 border-t border-yellow-200 px-2 py-1 text-xs text-yellow-800">
          <div className="font-semibold">Forgot cards ({forgotCards.length}):</div>
          <div className="break-words">{forgotCards.map(id => id.slice(0, 8)).join(', ')}</div>
        </div>
      ) : null}
    </div>
  );
};

renderWidget(QueueWindowWidget);
