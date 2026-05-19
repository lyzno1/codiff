// @ts-check

const DEFAULT_COPY_PENDING_COMMENTS_TIMEOUT_MS = 2000;

/**
 * @typedef {{
 *   id: number;
 *   isDestroyed: () => boolean;
 *   send: (channel: string, requestId: number) => void;
 * }} PendingCommentsWebContents
 */
/**
 * @typedef {{
 *   isDestroyed: () => boolean;
 *   webContents: PendingCommentsWebContents;
 * }} PendingCommentsBrowserWindow
 */
/**
 * @typedef {{
 *   sender: {
 *     id: number;
 *   };
 * }} PendingCommentsIpcEvent
 */
/**
 * @typedef {{
 *   resolve: (markdown: string) => void;
 *   webContentsId: number;
 * }} PendingCommentsRequest
 */

/**
 * @param {{
 *   clipboard: {
 *     writeText: (text: string) => void;
 *   };
 *   timeoutMs?: number;
 * }} options
 */
const createPendingCommentsClipboardController = ({
  clipboard,
  timeoutMs = DEFAULT_COPY_PENDING_COMMENTS_TIMEOUT_MS,
}) => {
  let nextRequestId = 0;
  /** @type {Map<number, PendingCommentsRequest>} */
  const pendingRequests = new Map();

  /**
   * @param {PendingCommentsIpcEvent} event
   * @param {number} requestId
   * @param {unknown} markdown
   */
  const handleCopyPendingCommentsResult = (event, requestId, markdown) => {
    const pending = pendingRequests.get(requestId);
    if (!pending || pending.webContentsId !== event.sender.id) {
      return;
    }

    pendingRequests.delete(requestId);
    pending.resolve(typeof markdown === 'string' ? markdown : '');
  };

  /** @param {PendingCommentsBrowserWindow} browserWindow */
  const requestPendingCommentsMarkdown = (browserWindow) =>
    new Promise((resolve) => {
      if (browserWindow.isDestroyed() || browserWindow.webContents.isDestroyed()) {
        resolve('');
        return;
      }

      const requestId = ++nextRequestId;
      const webContentsId = browserWindow.webContents.id;
      const timeout = setTimeout(() => {
        if (pendingRequests.delete(requestId)) {
          resolve('');
        }
      }, timeoutMs);

      pendingRequests.set(requestId, {
        resolve: (markdown) => {
          clearTimeout(timeout);
          resolve(markdown);
        },
        webContentsId,
      });

      browserWindow.webContents.send('codiff:copyPendingCommentsRequest', requestId);
    });

  /** @param {ReadonlyArray<PendingCommentsBrowserWindow>} browserWindows */
  const copyPendingCommentsToClipboard = async (browserWindows) => {
    const markdownBlocks = (
      await Promise.all(browserWindows.map((window) => requestPendingCommentsMarkdown(window)))
    ).filter(Boolean);

    if (markdownBlocks.length) {
      clipboard.writeText(markdownBlocks.join('\n\n'));
    }
  };

  return {
    copyPendingCommentsToClipboard,
    handleCopyPendingCommentsResult,
    requestPendingCommentsMarkdown,
  };
};

module.exports = {
  DEFAULT_COPY_PENDING_COMMENTS_TIMEOUT_MS,
  createPendingCommentsClipboardController,
};
