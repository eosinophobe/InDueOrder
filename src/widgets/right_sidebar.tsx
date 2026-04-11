import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppEvents, Queue, renderWidget, useAPIEventListener, usePlugin, useSyncedStorageState, useTrackerPlugin } from '@remnote/plugin-sdk';

type LoadedCard = {
  cardId: string;
  remId: string;
  typeLabel: string;
  nextRepetitionTime?: number;
  remText: string;
  remBackText?: string;
};

function formatCardType(type: 'forward' | 'backward' | { clozeId: string }) {
  if (typeof type === 'string') {
    return type;
  }

  return `cloze:${type.clozeId}`;
}

function toEpochMs(nextRepetitionTime?: number) {
  if (typeof nextRepetitionTime !== 'number' || !Number.isFinite(nextRepetitionTime)) {
    return null;
  }

  return nextRepetitionTime < 1_000_000_000_000
    ? nextRepetitionTime * 1000
    : nextRepetitionTime;
}

function formatNextRepetitionTime(nextRepetitionTime?: number) {
  const epochMs = toEpochMs(nextRepetitionTime);
  if (epochMs === null) {
    return 'Not scheduled';
  }

  return `${new Date(epochMs).toLocaleString()} (${nextRepetitionTime})`;
}

function formatDueStatus(nextRepetitionTime?: number) {
  const epochMs = toEpochMs(nextRepetitionTime);
  if (epochMs === null) {
    return 'No schedule';
  }

  const now = Date.now();
  const diffMs = epochMs - now;
  const absSeconds = Math.floor(Math.abs(diffMs) / 1000);

  if (diffMs <= 0) {
    return `Due now (${absSeconds}s overdue)`;
  }

  return `Not due yet (${absSeconds}s remaining)`;
}

function isCardDue(nextRepetitionTime?: number) {
  const epochMs = toEpochMs(nextRepetitionTime);
  if (epochMs === null) {
    return false;
  }

  return epochMs <= Date.now();
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

async function safeRichTextToString(plugin: ReturnType<typeof usePlugin>, richText: unknown) {
  if (!richText) {
    return '';
  }

  try {
    return await plugin.richText.toString(richText as any);
  } catch {
    return '';
  }
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

export const CustomQueueWidget = () => {
  const plugin = usePlugin();
  const autoLoadFocusedRem =
    useTrackerPlugin(() => plugin.settings.getSetting<boolean>('autoload-focused-rem')) ?? true;
  const [savedRemId, setSavedRemId] = useSyncedStorageState<string>('default-rem-id', '');
  const [manualQueueCardIdsJson, setManualQueueCardIdsJson] = useSyncedStorageState<string>('manual-queue-card-ids-json', '[]');
  const [queueShouldStart, setQueueShouldStart] = useSyncedStorageState<string>('queue-should-start', '');
  const [debugPopupMountCount] = useSyncedStorageState<string>('queue-debug-popup-mount-count', '0');
  const [debugMismatchRemountCount] = useSyncedStorageState<string>('queue-debug-mismatch-remount-count', '0');
  const [debugRenderKey] = useSyncedStorageState<string>('queue-debug-render-key', '0');
  const [debugLastMessage] = useSyncedStorageState<string>('queue-debug-last-message', '');
  const [debugEventsJson] = useSyncedStorageState<string>('queue-debug-events-json', '[]');

  const [remIdInput, setRemIdInput] = useState(savedRemId);
  const [activeRemId, setActiveRemId] = useState<string | null>(savedRemId || null);
  const [cards, setCards] = useState<LoadedCard[]>([]);
  const [activeRemText, setActiveRemText] = useState<string | null>(null);
    // Update activeRemText whenever activeRemId changes
    useEffect(() => {
      let cancelled = false;
      async function fetchRemText() {
        if (!activeRemId) {
          setActiveRemText(null);
          return;
        }
        const rem = await plugin.rem.findOne(activeRemId);
        if (!rem) {
          setActiveRemText(null);
          return;
        }
        const text = await safeRichTextToString(plugin, rem.text);
        if (!cancelled) setActiveRemText(text);
      }
      fetchRemText();
      return () => { cancelled = true; };
    }, [activeRemId, plugin]);
  const [queueCardIds, setQueueCardIds] = useState<string[]>([]);
  const [queueRunId, setQueueRunId] = useState(0);
  const [queueStarted, setQueueStarted] = useState(false);
  const [shouldRenderQueue, setShouldRenderQueue] = useState(false);
  const [status, setStatus] = useState('Choose a Rem and load its cards.');
  const [debugEvents, setDebugEvents] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const lastFocusedRemIdRef = useRef<string>('');
  const lastRequestedRemIdRef = useRef<string>('');
  const queueAdvanceLockRef = useRef(false);
  const queueCardIdsRef = useRef<string[]>([]);
  const queueStartedRef = useRef(false);
  const queueAdvancedForCurrentCardRef = useRef(false);
  const queueEnteredAtRef = useRef(0);
  const queueAnswerActionArmedRef = useRef(false);
  const queueAnswerActionAtRef = useRef(0);
  const queueExitSeenForCurrentCardRef = useRef(false);
  const lastDebugToastAtRef = useRef(0);
  const lastDebugInputAtRef = useRef(0);
  const queueCardBaselineRef = useRef<{ cardId: string; lastRep: number | null; nextRep: number | null } | null>(null);
  const queueRepetitionHandledForCardRef = useRef(false);

  let persistentDebugEvents: string[] = [];
  try {
    const parsed = JSON.parse(debugEventsJson);
    if (Array.isArray(parsed)) {
      persistentDebugEvents = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    persistentDebugEvents = [];
  }

  const pushDebugEvent = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugEvents((prev) => {
      const next = [...prev, `${timestamp} ${message}`];
      return next.slice(-8);
    });
  }, []);

  const debugToast = useCallback((message: string) => {
    const now = Date.now();
    if (now - lastDebugToastAtRef.current < 250) {
      return;
    }

    lastDebugToastAtRef.current = now;
    pushDebugEvent(message);
    void plugin.app.toast(message);
  }, [plugin, pushDebugEvent]);

  const resolveDocumentRemId = useCallback(async (startRemId: string) => {
    const startRem = await plugin.rem.findOne(startRemId);
    if (!startRem) {
      return startRemId;
    }

    let currentRem = startRem;
    for (let i = 0; i < 64; i += 1) {
      const isDocument = await currentRem.isDocument();
      if (isDocument) {
        return currentRem._id;
      }

      const parent = await currentRem.getParentRem();
      if (!parent) {
        return currentRem._id;
      }

      currentRem = parent;
    }

    return currentRem._id;
  }, [plugin]);

  const applyFocusedRemId = useCallback(async (nextRemId: string) => {
    if (!nextRemId) {
      return;
    }

    lastRequestedRemIdRef.current = nextRemId;
    const documentRemId = await resolveDocumentRemId(nextRemId);
    if (lastRequestedRemIdRef.current !== nextRemId) {
      return;
    }

    const finalRemId = documentRemId || nextRemId;

    lastFocusedRemIdRef.current = nextRemId;
    setRemIdInput(finalRemId);
    setActiveRemId((prev) => (prev === finalRemId ? prev : finalRemId));
    setQueueStarted(false);
    void setSavedRemId(finalRemId);
  }, [resolveDocumentRemId, setSavedRemId]);

  useAPIEventListener(AppEvents.FocusedRemChange, 'custom-queue-focused-rem-change', (args: any) => {
    if (!autoLoadFocusedRem) {
      return;
    }

    const eventRemId =
      args?.remId ??
      args?.focusedRemId ??
      args?.id ??
      args?.rem?._id;

    if (typeof eventRemId === 'string' && eventRemId.trim().length > 0) {
      void applyFocusedRemId(eventRemId.trim());
      return;
    }

    void (async () => {
      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem) {
        return;
      }

      void applyFocusedRemId(focusedRem._id);
    })();
  });

  useEffect(() => {
    if (!autoLoadFocusedRem) {
      return;
    }

    let cancelled = false;

    const syncFocusedRem = async () => {
      const focusedRem = await plugin.focus.getFocusedRem();
      if (cancelled || !focusedRem) {
        return;
      }

      if (focusedRem._id === lastFocusedRemIdRef.current) {
        return;
      }

      void applyFocusedRemId(focusedRem._id);
    };

    void syncFocusedRem();
    const interval = window.setInterval(() => {
      void syncFocusedRem();
    }, 700);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [autoLoadFocusedRem, plugin, applyFocusedRemId]);

  useEffect(() => {
    setRemIdInput(savedRemId);
    if (!activeRemId && savedRemId) {
      setActiveRemId(savedRemId);
    }
  }, [savedRemId, activeRemId]);

  useEffect(() => {
    let cancelled = false;

    async function maybeLoadFocusedRem() {
      if (!autoLoadFocusedRem || savedRemId || activeRemId) {
        return;
      }

      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem || cancelled) {
        return;
      }

      void applyFocusedRemId(focusedRem._id);
    }

    maybeLoadFocusedRem();

    return () => {
      cancelled = true;
    };
  }, [activeRemId, autoLoadFocusedRem, plugin, savedRemId, applyFocusedRemId]);

  useEffect(() => {
    setShouldRenderQueue(false);

    if (!queueStarted || queueCardIds.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setShouldRenderQueue(true);
    }, 50);

    return () => {
      window.clearTimeout(timer);
    };
  }, [queueStarted, queueCardIds.length, queueRunId]);

  useEffect(() => {
    queueCardIdsRef.current = queueCardIds;
    queueAdvancedForCurrentCardRef.current = false;
    queueEnteredAtRef.current = 0;
    queueAnswerActionArmedRef.current = false;
    queueAnswerActionAtRef.current = 0;
    queueExitSeenForCurrentCardRef.current = false;
    queueCardBaselineRef.current = null;
    queueRepetitionHandledForCardRef.current = false;
  }, [queueCardIds]);

  useEffect(() => {
    if (!queueStarted || !shouldRenderQueue || queueCardIds.length === 0) {
      return;
    }

    if (queueEnteredAtRef.current <= 0) {
      queueEnteredAtRef.current = Date.now();
    }

    if (debugEvents.length === 0) {
      pushDebugEvent('queue render active');
    }
  }, [queueStarted, shouldRenderQueue, queueCardIds.length, queueCardIds[0]]);

  useEffect(() => {
    if (!queueStarted || queueCardIds.length === 0) {
      return;
    }

    let cancelled = false;
    const activeCardId = queueCardIds[0];

    const loadBaseline = async () => {
      const card = await plugin.card.findOne(activeCardId);
      if (cancelled || !card) {
        return;
      }

      queueCardBaselineRef.current = {
        cardId: activeCardId,
        lastRep: typeof card.lastRepetitionTime === 'number' ? card.lastRepetitionTime : null,
        nextRep: typeof card.nextRepetitionTime === 'number' ? card.nextRepetitionTime : null,
      };
      pushDebugEvent(`baseline ready for ${activeCardId}`);
    };

    void loadBaseline();

    return () => {
      cancelled = true;
    };
  }, [plugin, pushDebugEvent, queueCardIds, queueStarted]);

  useEffect(() => {
    queueStartedRef.current = queueStarted;
  }, [queueStarted]);

  useEffect(() => {
    if (queueShouldStart !== 'true') {
      return;
    }

    let ids: string[] = [];
    try {
      const parsed = JSON.parse(manualQueueCardIdsJson);
      if (Array.isArray(parsed)) {
        ids = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      ids = [];
    }

    setQueueShouldStart('');

    if (ids.length === 0) {
      return;
    }

    void plugin.storage.setSynced('manual-queue-total-count', String(ids.length));

    void (async () => {
      try {
        await plugin.storage.setSynced('custom-queue-css-enabled', 'true');
        await plugin.widget.openPopup('queue_content');
        setStatus(`Queue opened in popup with ${ids.length} card${ids.length === 1 ? '' : 's'}.`);
      } catch {
        await plugin.storage.setSynced('custom-queue-css-enabled', 'false');
        setStatus('Could not open popup queue window.');
      }
    })();
  }, [queueShouldStart]);

  const advanceInlineQueue = useCallback((forceAdvance?: boolean) => {
    if (!queueStartedRef.current || queueCardIdsRef.current.length === 0) {
      return;
    }

    if (queueAdvanceLockRef.current) {
      return;
    }

    queueAdvanceLockRef.current = true;
    queueAdvancedForCurrentCardRef.current = true;
    queueEnteredAtRef.current = 0;
    queueAnswerActionArmedRef.current = false;
    queueAnswerActionAtRef.current = 0;
    queueExitSeenForCurrentCardRef.current = false;
    queueRepetitionHandledForCardRef.current = true;

    // Force a clean teardown to avoid stacked/overlay queue UI artifacts in the sidebar.
    setShouldRenderQueue(false);

    setQueueCardIds((prev) => {
      const next = prev.slice(1);
      queueCardIdsRef.current = next;
      void setManualQueueCardIdsJson(JSON.stringify(next));

      if (next.length === 0) {
        setShouldRenderQueue(false);
        setStatus('Queue complete. Reviewed all selected due cards in document order.');
      } else {
        setQueueRunId((runId) => runId + 1);
        window.setTimeout(() => {
          setShouldRenderQueue(true);
        }, 45);
        setStatus(`Queue advanced: ${next.length} due card${next.length === 1 ? '' : 's'} remaining.`);
      }

      window.setTimeout(() => {
        queueAdvanceLockRef.current = false;
      }, 160);

      return next;
    });
  }, [setManualQueueCardIdsJson]);

  useAPIEventListener(AppEvents.QueueCompleteCard, 'custom-queue-inline-complete-card', (args: any) => {
    const completedCardId = args?.cardId ?? args?.id ?? args?.card?._id;
    debugToast(`QueueCompleteCard: ${typeof completedCardId === 'string' ? completedCardId : 'no-card-id'}`);
    advanceInlineQueue(false);
  });

  useAPIEventListener(AppEvents.QueueEnter, 'custom-queue-inline-enter', (args: any) => {
    if (!queueStartedRef.current || queueCardIdsRef.current.length === 0) {
      return;
    }
    const enteredCardId = args?.cardId ?? args?.id ?? args?.card?._id;
    debugToast(`QueueEnter: ${typeof enteredCardId === 'string' ? enteredCardId : 'no-card-id'}`);
    queueEnteredAtRef.current = Date.now();
  });

  useAPIEventListener(AppEvents.RevealAnswer, 'custom-queue-inline-reveal-answer-debug', () => {
    if (!queueStartedRef.current || queueCardIdsRef.current.length === 0) {
      return;
    }

    debugToast('RevealAnswer event');
  });

  // QueueExit event listener moved to queue_content

  useEffect(() => {
    if (!queueStarted || queueCardIds.length === 0) {
      return;
    }

    const watcher = window.setInterval(() => {
      if (!queueStartedRef.current || queueCardIdsRef.current.length === 0) {
        return;
      }

      if (queueAdvancedForCurrentCardRef.current || queueAdvanceLockRef.current) {
        return;
      }

      const activeCardId = queueCardIdsRef.current[0];
      const baseline = queueCardBaselineRef.current;
      if (!activeCardId || !baseline || baseline.cardId !== activeCardId) {
        return;
      }

        if (queueRepetitionHandledForCardRef.current) {
          return;
        }

      void (async () => {
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

        queueRepetitionHandledForCardRef.current = true;
        pushDebugEvent(`card repetition changed: ${activeCardId}`);
        advanceInlineQueue(true);
      })();
    }, 240);

    return () => {
      window.clearInterval(watcher);
    };
  }, [advanceInlineQueue, plugin, pushDebugEvent, queueCardIds.length, queueStarted]);

  useEffect(() => {
    if (!queueStarted) {
      return;
    }

    const answerButtonTerms = [
      'forgot',
      'partially recalled',
      'recalled with effort',
      'easily recalled',
      'again',
      'hard',
      'good',
      'easy',
    ];

    const onDocumentClick = (event: MouseEvent) => {
      if (!queueStartedRef.current || queueCardIdsRef.current.length === 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const button = target.closest('button');
      const text = (button?.textContent || '').trim().toLowerCase();
      if (!text) {
        return;
      }

      if (!answerButtonTerms.some((term) => text.includes(term))) {
        return;
      }

      queueAnswerActionArmedRef.current = true;
      queueAnswerActionAtRef.current = Date.now();
      if (Date.now() - lastDebugInputAtRef.current > 250) {
        lastDebugInputAtRef.current = Date.now();
        pushDebugEvent(`click answer button: ${text}`);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!queueStartedRef.current || queueCardIdsRef.current.length === 0) {
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

      queueAnswerActionArmedRef.current = true;
      queueAnswerActionAtRef.current = Date.now();
      if (Date.now() - lastDebugInputAtRef.current > 250) {
        lastDebugInputAtRef.current = Date.now();
        pushDebugEvent(`keydown answer key: ${event.key || event.code}`);
      }
    };

    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [queueStarted, pushDebugEvent]);

  useEffect(() => {
    if (!queueStarted || queueCardIds.length === 0) {
      return;
    }

    const isCongratsText = (text: string) => {
      const normalized = text.toLowerCase().replace(/[’‘]/g, "'");
      return normalized.includes("you've finished practicing")
        || normalized.includes('finished practicing all your cards')
        || normalized.includes('congratulations')
        || normalized.includes('congrats');
    };

    const watcher = window.setInterval(() => {
      if (!queueStartedRef.current || queueCardIdsRef.current.length === 0) {
        return;
      }

      if (!queueAnswerActionArmedRef.current && !queueExitSeenForCurrentCardRef.current) {
        return;
      }

      if (queueAdvancedForCurrentCardRef.current || queueAdvanceLockRef.current) {
        return;
      }

      if (Date.now() - queueAnswerActionAtRef.current < 180) {
        return;
      }

      const text = document.body?.innerText || '';
      if (!isCongratsText(text)) {
        return;
      }

      debugToast('Congrats watcher fallback advance');
      advanceInlineQueue(true);
    }, 120);

    return () => {
      window.clearInterval(watcher);
    };
  }, [advanceInlineQueue, queueCardIds.length, queueStarted]);

  useEffect(() => {
    let cancelled = false;

    async function loadCards() {
      if (!activeRemId) {
        setCards([]);
        setQueueCardIds([]);
        setQueueStarted(false);
        return;
      }

      setIsLoading(true);
      setQueueCardIds([]);
      setQueueStarted(false);
      setStatus('Loading cards from Rem...');

      try {
        const rem = await plugin.rem.findOne(activeRemId);

        if (!rem) {
          throw new Error('Rem not found or not accessible with the current plugin scope.');
        }

        await rem.isDocument();
        const orderedRems = await rem.allRemInDocumentOrPortal();
        const remsInDocumentOrder = orderedRems.length > 0 ? orderedRems : [rem];

        const loadedCardById = new Map<string, LoadedCard>();

        for (const currentRem of remsInDocumentOrder) {
          const currentCards = await currentRem.getCards();
          const remText = await safeRichTextToString(plugin, currentRem.text);
          const remBackTextRaw = await safeRichTextToString(plugin, currentRem.backText);
          const remBackText = remBackTextRaw || undefined;

          for (const card of currentCards) {
            if (loadedCardById.has(card._id)) {
              continue;
            }

            loadedCardById.set(card._id, {
              cardId: card._id,
              remId: card.remId,
              typeLabel: formatCardType(card.type),
              nextRepetitionTime: card.nextRepetitionTime,
              remText,
              remBackText,
            });
          }
        }

        const loadedCards = Array.from(loadedCardById.values());
        const dueCardCount = loadedCards.filter((card) => isCardDue(card.nextRepetitionTime)).length;
        const traversalPreview = remsInDocumentOrder.slice(0, 8).map((currentRem) => currentRem._id);

        if (cancelled) {
          return;
        }

        setCards(loadedCards);
        setStatus(
          loadedCards.length > 0
            ? `Loaded ${loadedCards.length} card${loadedCards.length === 1 ? '' : 's'} from the selected document and all descendants. Click Start Queue to begin reviewing.`
            : 'The selected document does not currently generate any cards.'
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : 'Failed to load cards.';
        setCards([]);
        setQueueCardIds([]);
        setStatus(message);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadCards();

    return () => {
      cancelled = true;
    };
  }, [activeRemId, plugin]);

  async function loadFocusedRem() {
    const focusedRem = await plugin.focus.getFocusedRem();

    if (!focusedRem) {
      setStatus('No focused Rem is currently available.');
      return;
    }

    await applyFocusedRemId(focusedRem._id);
  }

  async function submitRemId() {
    const trimmedRemId = remIdInput.trim();

    if (!trimmedRemId) {
      setActiveRemId(null);
      setCards([]);
      setQueueCardIds([]);
      setQueueStarted(false);
      setStatus('Enter a Rem ID or load the focused Rem.');
      await setSavedRemId('');
      return;
    }

    await applyFocusedRemId(trimmedRemId);
  }

  async function startQueue() {
    if (cards.length === 0) {
      setStatus('No cards loaded yet. Load cards first, then start the queue.');
      return;
    }

    const dueCards = cards.filter((card) => isCardDue(card.nextRepetitionTime));
    if (dueCards.length === 0) {
      setStatus('No due cards found in the selected document tree.');
      return;
    }

    const nextQueueCardIds = dueCards.map((card) => card.cardId);
    await setManualQueueCardIdsJson(JSON.stringify(nextQueueCardIds));
    await plugin.storage.setSynced('manual-queue-total-count', String(nextQueueCardIds.length));
    const modeLabel = 'strict single-card mode';

    try {
      await plugin.storage.setSynced('custom-queue-css-enabled', 'true');
      await plugin.widget.openPopup('queue_content');
      setStatus(`Queue opened in popup with ${dueCards.length} due card${dueCards.length === 1 ? '' : 's'} using ${modeLabel}.`);
    } catch {
      await plugin.storage.setSynced('custom-queue-css-enabled', 'false');
      setStatus('Could not open popup queue window.');
    }
  }

  async function clearPersistentDebug() {
    await plugin.storage.setSynced('queue-debug-popup-mount-count', '0');
    await plugin.storage.setSynced('queue-debug-mismatch-remount-count', '0');
    await plugin.storage.setSynced('queue-debug-render-key', '0');
    await plugin.storage.setSynced('queue-debug-last-message', '');
    await plugin.storage.setSynced('queue-debug-events-json', '[]');
    pushDebugEvent('persistent debug cleared');
  }

  function closeQueue() {
    void plugin.storage.setSynced('custom-queue-css-enabled', 'false');
    setQueueStarted(false);
    setShouldRenderQueue(false);
    setStatus('Queue closed.');
  }

  // Removed conditional early return for queueStarted/queueCardIds so Start Queue button is always visible

  return (
    <div className="m-2 flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div>
        {/* Widget logo removed as requested */}
        {/* Document title with icon */}
        <div className="flex items-center gap-3">
          <img
            src="file:///Applications/RemNote.app/Contents/Resources/app.asar/build/offline_assets/emoji/document-blue.svg"
            alt="Document Icon"
            style={{ width: 32, height: 32 }}
          />
          <h1 className="text-lg font-semibold text-slate-900">
            {activeRemText ? activeRemText : 'Custom Card Queue'}
          </h1>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          There are {cards.filter(card => isCardDue(card.nextRepetitionTime)).length} due cards in this document
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
          <button
            className="mt-2 rounded-md px-3 py-2 text-sm font-medium"
            onClick={startQueue}
            type="button"
            style={{ backgroundColor: '#104862', color: 'white', opacity: 1, visibility: 'visible', pointerEvents: 'auto' }}
          >
            Practice all due cards in order
          </button>
        </div>
      </div>

      {/* Rem ID input removed as requested */}

      <div className="flex flex-wrap gap-2">
        <button
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          onClick={submitRemId}
          type="button"
        >
          Load Rem Cards
        </button>
        {/* Use Focused Rem button removed as requested */}
      </div>

      {/* Status message removed as requested */}

      {/* Persistent Queue Debug section removed as requested */}

      {/* Active Rem ID section removed as requested */}

      {/* Cards and Selected Rem View sections removed as requested */}
    </div>
  );
};

renderWidget(CustomQueueWidget);
