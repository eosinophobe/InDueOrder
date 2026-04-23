import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppEvents, renderWidget, useAPIEventListener, usePlugin, useSyncedStorageState } from '@remnote/plugin-sdk';

type LoadedCard = {
  cardId: string;
  nextRepetitionTime?: number;
};

function toEpochMs(nextRepetitionTime?: number) {
  if (typeof nextRepetitionTime !== 'number' || !Number.isFinite(nextRepetitionTime)) {
    return null;
  }

  return nextRepetitionTime < 1_000_000_000_000
    ? nextRepetitionTime * 1000
    : nextRepetitionTime;
}

function isCardDue(nextRepetitionTime?: number) {
  const epochMs = toEpochMs(nextRepetitionTime);
  if (epochMs === null) {
    return false;
  }

  return epochMs <= Date.now();
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

export const CustomQueueWidget = () => {
  const plugin = usePlugin();
  const [manualQueueCardIdsJson, setManualQueueCardIdsJson] =
    useSyncedStorageState<string>('manual-queue-card-ids-json', '[]');
  const [queueShouldStart, setQueueShouldStart] = useSyncedStorageState<string>('queue-should-start', '');

  const [activeRemId, setActiveRemId] = useState<string | null>(null);
  const [activeRemText, setActiveRemText] = useState<string>('Custom Card Queue');
  const [cards, setCards] = useState<LoadedCard[]>([]);

  const resolveDocumentRemId = useCallback(async (startRemId: string) => {
    const startRem = await plugin.rem.findOne(startRemId);
    if (!startRem) {
      return startRemId;
    }

    let currentRem = startRem;
    for (let i = 0; i < 64; i += 1) {
      if (await currentRem.isDocument()) {
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

    const documentRemId = await resolveDocumentRemId(nextRemId);
    setActiveRemId((prev) => (prev === documentRemId ? prev : documentRemId));
  }, [resolveDocumentRemId]);

  useAPIEventListener(AppEvents.FocusedRemChange, 'custom-queue-focused-rem-change', (args: any) => {
    const eventRemId = args?.remId ?? args?.focusedRemId ?? args?.id ?? args?.rem?._id;

    if (typeof eventRemId === 'string' && eventRemId.trim().length > 0) {
      void applyFocusedRemId(eventRemId.trim());
      return;
    }

    void (async () => {
      const focusedRem = await plugin.focus.getFocusedRem();
      if (focusedRem) {
        await applyFocusedRemId(focusedRem._id);
      }
    })();
  });

  useEffect(() => {
    let cancelled = false;

    const syncFocusedRem = async () => {
      const focusedRem = await plugin.focus.getFocusedRem();
      if (cancelled || !focusedRem) {
        return;
      }

      await applyFocusedRemId(focusedRem._id);
    };

    void syncFocusedRem();
    const interval = window.setInterval(() => {
      void syncFocusedRem();
    }, 700);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [applyFocusedRemId, plugin]);

  useEffect(() => {
    let cancelled = false;

    const loadActiveDocument = async () => {
      if (!activeRemId) {
        setActiveRemText('Custom Card Queue');
        setCards([]);
        return;
      }

      const rem = await plugin.rem.findOne(activeRemId);
      if (!rem || cancelled) {
        return;
      }

      const remText = await safeRichTextToString(plugin, rem.text);
      const orderedRems = await rem.allRemInDocumentOrPortal();
      const remsInDocumentOrder = orderedRems.length > 0 ? orderedRems : [rem];
      const loadedCardIds = new Set<string>();
      const loadedCards: LoadedCard[] = [];

      for (const currentRem of remsInDocumentOrder) {
        const currentCards = await currentRem.getCards();

        for (const card of currentCards) {
          if (loadedCardIds.has(card._id)) {
            continue;
          }

          loadedCardIds.add(card._id);
          loadedCards.push({
            cardId: card._id,
            nextRepetitionTime: card.nextRepetitionTime,
          });
        }
      }

      if (cancelled) {
        return;
      }

      setActiveRemText(remText || 'Untitled Document');
      setCards(loadedCards);
    };

    void loadActiveDocument();

    return () => {
      cancelled = true;
    };
  }, [activeRemId, plugin]);

  useEffect(() => {
    if (queueShouldStart !== 'true') {
      return;
    }

    let ids: string[] = [];
    try {
      const parsed = JSON.parse(manualQueueCardIdsJson);
      if (Array.isArray(parsed)) {
        ids = parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch {
      ids = [];
    }

    setQueueShouldStart('');

    if (ids.length === 0) {
      return;
    }

    void plugin.storage.setSynced('manual-queue-total-count', String(ids.length));
    void plugin.storage.setSynced('custom-queue-css-enabled', 'true');
    void plugin.widget.openPopup('queue_content');
  }, [manualQueueCardIdsJson, plugin, queueShouldStart, setQueueShouldStart]);

  const dueCards = useMemo(
    () => cards.filter((card) => isCardDue(card.nextRepetitionTime)),
    [cards],
  );

  const startQueue = useCallback(async () => {
    if (dueCards.length === 0) {
      return;
    }

    const queueCardIds = dueCards.map((card) => card.cardId);
    await setManualQueueCardIdsJson(JSON.stringify(queueCardIds));
    await plugin.storage.setSynced('manual-queue-total-count', String(queueCardIds.length));
    await plugin.storage.setSynced('custom-queue-css-enabled', 'true');
    await plugin.widget.openPopup('queue_content');
  }, [dueCards, plugin, setManualQueueCardIdsJson]);

  return (
    <div className="m-2 flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-3">
        <img
          src="file:///Applications/RemNote.app/Contents/Resources/app.asar/build/offline_assets/emoji/document-blue.svg"
          alt="Document Icon"
          style={{ width: 32, height: 32 }}
        />
        <h1 className="text-lg font-semibold text-slate-900">{activeRemText}</h1>
      </div>

      <p className="text-sm text-slate-600">
        There {dueCards.length === 1 ? 'is' : 'are'} {dueCards.length} due card{dueCards.length === 1 ? '' : 's'} in this document.
      </p>

      <button
        className="rounded-md px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
        onClick={() => void startQueue()}
        type="button"
        disabled={dueCards.length === 0}
        style={{ backgroundColor: dueCards.length === 0 ? undefined : '#104862' }}
      >
        Practice all due cards in order
      </button>
    </div>
  );
};

renderWidget(CustomQueueWidget);
