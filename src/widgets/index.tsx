
// queueCompletionCleanupInterval is declared at the top of the file for module-level access
import { declareIndexPlugin, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
let queueCompletionCleanupInterval: number | null = null;
import '../style.css';
import '../index.css'; // import <widget-name>.css

const QUEUE_CSS_FLAG_KEY = 'custom-queue-css-enabled';
const QUEUE_HEARTBEAT_KEY = 'custom-queue-popup-heartbeat';
const QUEUE_REMAINING_COUNT_KEY = 'custom-queue-remaining-count';
const QUEUE_COMPLETION_POPUP_AT_KEY = 'custom-queue-completion-popup-at';
const QUEUE_CSS_ID = 'custom-queue-global-css';
const QUEUE_CSS_BASE_RULE = `canvas {
  display: none !important;
}

.queue-message:has([data-test="Queue Message Heading"]) * {
  color: white !important;
  background-color: white !important;
  text-color: white !important
}

.queue-message:has([data-test="Queue Message Heading"]) svg {
  display: none !important
}

.queue-message:has([data-test="Queue Message Heading"]) img {
  display: none !important
}

button[data-test="Button With Label: Create More Flashcards"] {
  border: 2px solid white !important;
}

.queue-message:has([data-test="Queue Message Heading"]) .bg-purple-0 {
  border-color: white !important
}

.rn-queue-container{
    background-color: white !important;
    }

[data-test="Popup Background"] {
  background-color: white !important
}

.rn-queue__card-counter .queue__count {
  color: transparent; /* hide the "1" */
  position: relative;
}

.rn-queue__card-counter .queue__count::after {
  content: var(--custom-queue-remaining-count);
  color: var(--custom-queue-counter-color);
  position: absolute;
  left: 0;
  top: 0;
}
  button[data-test="accuracy-button-0.01"] {
  pointer-events: none;
  opacity: 0.5;
}

[data-test="Queue Back Button"] {
  display: none !important;
}

`;

function buildQueueCssRule(remainingCount: number) {
  const safeCount = Number.isFinite(remainingCount) && remainingCount >= 0
    ? Math.floor(remainingCount)
    : 0;

  return `${QUEUE_CSS_BASE_RULE}
:root {
  --custom-queue-remaining-count: '${safeCount}';
  --custom-queue-counter-color: ${safeCount === 0 ? 'transparent' : 'black'};
}
`;
}

let queueCssSyncInterval: number | null = null;
let queueCompletionPopupInterval: number | null = null;

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

const COMPLETION_HEARTBEAT_KEY = 'custom-queue-completion-popup-heartbeat';
const FORGOT_CARDS_KEY = 'queue-forgot-cards-json';
const CLEAR_ON_CLOSE_KEY = 'queue-completion-clear-forgot-list-on-close';

const maybeCleanupForgottenCards = async (plugin: ReactRNPlugin) => {
  const heartbeatRaw = await plugin.storage.getSynced<string>(COMPLETION_HEARTBEAT_KEY);
  const heartbeatMs = Number.parseInt(heartbeatRaw ?? '0', 10);
  const heartbeatIsFresh = Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs < 2200;
  const clearOnClose = (await plugin.storage.getSynced<string>(CLEAR_ON_CLOSE_KEY)) === 'true';
  if (!heartbeatIsFresh && clearOnClose) {
    // Clear forgotten card list if not already empty, and only once
    const raw = await plugin.storage.getSynced<string>(FORGOT_CARDS_KEY);
    if (raw && raw !== '[]') {
      await plugin.storage.setSynced(FORGOT_CARDS_KEY, '[]');
    }
    await plugin.storage.setSynced(CLEAR_ON_CLOSE_KEY, '');
  }
};

async function onActivate(plugin: ReactRNPlugin) {
  // --- One-time forgotten card list clearance logic ---
  queueCompletionCleanupInterval = window.setInterval(() => {
    void maybeCleanupForgottenCards(plugin);
  }, 1000);
  const maybeOpenCompletionPopup = async () => {
    const raw = await plugin.storage.getSynced<string>(QUEUE_COMPLETION_POPUP_AT_KEY);
    const openAtMs = Number.parseInt(raw ?? '0', 10);

    if (!Number.isFinite(openAtMs) || openAtMs <= 0 || Date.now() < openAtMs) {
      return;
    }

    await plugin.storage.setSynced(QUEUE_COMPLETION_POPUP_AT_KEY, '0');
    await plugin.widget.openPopup('queue_completion');
  };

  const syncQueueCss = async () => {
    const enabledByFlag = (await plugin.storage.getSynced<string>(QUEUE_CSS_FLAG_KEY)) === 'true';
    const heartbeatRaw = await plugin.storage.getSynced<string>(QUEUE_HEARTBEAT_KEY);
    const remainingRaw = await plugin.storage.getSynced<string>(QUEUE_REMAINING_COUNT_KEY);
    const remainingCount = Number.parseInt(remainingRaw ?? '0', 10);
    const heartbeatMs = Number.parseInt(heartbeatRaw ?? '0', 10);
    const heartbeatIsFresh = Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs < 2200;
    const enabled = enabledByFlag && heartbeatIsFresh;

    await plugin.app.registerCSS(QUEUE_CSS_ID, enabled ? buildQueueCssRule(remainingCount) : '');

    if (enabledByFlag && !heartbeatIsFresh) {
      await plugin.storage.setSynced(QUEUE_CSS_FLAG_KEY, 'false');
    }
  };

  const handleStorageChange = () => {
    void syncQueueCss();
    void maybeOpenCompletionPopup();
  };

  plugin.event.addListener('storage.synced-change', 'custom-queue-css-storage-sync', handleStorageChange);
  await syncQueueCss();

  queueCssSyncInterval = window.setInterval(() => {
    void syncQueueCss();
  }, 500);

  queueCompletionPopupInterval = window.setInterval(() => {
    void maybeOpenCompletionPopup();
  }, 100);

  await plugin.settings.registerStringSetting({
    id: 'default-rem-id',
    title: 'Default Rem ID',
    defaultValue: '',
  });

  await plugin.settings.registerBooleanSetting({
    id: 'autoload-focused-rem',
    title: 'Autoload Focused Rem On Open',
    defaultValue: true,
  });

  await plugin.app.registerCommand({
    id: 'load-focused-rem-into-custom-queue',
    name: 'Load Focused Rem Into Custom Queue',
    action: async () => {
      const focusedRem = await plugin.focus.getFocusedRem();

      if (!focusedRem) {
        await plugin.app.toast('No focused Rem found.');
        return;
      }

      await plugin.storage.setSynced('default-rem-id', focusedRem._id);
      await plugin.app.toast('Focused Rem saved for the custom queue.');
    },
  });

  await plugin.app.registerCommand({
    id: 'start-custom-queue',
    name: 'Start Custom Queue',
    action: async () => {
      const focusedRem = await plugin.focus.getFocusedRem();

      if (!focusedRem) {
        await plugin.app.toast('Place your cursor inside a Rem first, then run this command.');
        return;
      }

      const remCards = await focusedRem.getCards();

      if (!remCards || remCards.length === 0) {
        await plugin.app.toast('No cards found for that Rem.');
        return;
      }

      const dueCards = remCards.filter((c: any) => isCardDue(c.nextRepetitionTime));
      if (dueCards.length === 0) {
        await plugin.app.toast('No due cards found for that Rem.');
        return;
      }

      const cardIds = dueCards.map((c: any) => c._id);
      await plugin.storage.setSynced('manual-queue-card-ids-json', JSON.stringify(cardIds));
      await plugin.storage.setSynced('queue-should-start', 'true');
      await plugin.app.toast(`Starting queue with ${cardIds.length} due card${cardIds.length === 1 ? '' : 's'}…`);
    },
  });

  await plugin.app.registerWidget('right_sidebar', WidgetLocation.RightSidebar, {
    dimensions: { height: 900, width: '100%' },
    widgetTabTitle: 'Custom Queue',
    widgetTabIcon: 'https://github.com/eosinophobe/InDueOrder/raw/main/public/logo.png',
  });

  await plugin.app.registerWidget('queue_content', WidgetLocation.Popup, {
    dimensions: { height: 800, width: 1200 },
    widgetTabTitle: 'Manual Queue',
  });

  await plugin.app.registerWidget('queue_completion', WidgetLocation.Popup, {
    dimensions: { height: 800, width: 1200 },
    widgetTabTitle: 'Queue Complete',
  });



}

async function onDeactivate(plugin: ReactRNPlugin) {
  plugin.event.removeListener('storage.synced-change', 'custom-queue-css-storage-sync');

  if (queueCssSyncInterval !== null) {
    window.clearInterval(queueCssSyncInterval);
    queueCssSyncInterval = null;
  }

  if (queueCompletionPopupInterval !== null) {
    window.clearInterval(queueCompletionPopupInterval);
    queueCompletionPopupInterval = null;
  }

  // Clear the cleanup interval if it was set
  if (typeof queueCompletionCleanupInterval !== 'undefined' && queueCompletionCleanupInterval !== null) {
    window.clearInterval(queueCompletionCleanupInterval);
    queueCompletionCleanupInterval = null;
  }

  await plugin.app.registerCSS(QUEUE_CSS_ID, '');
}

declareIndexPlugin(onActivate, onDeactivate);
