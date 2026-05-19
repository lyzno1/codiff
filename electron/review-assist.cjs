// @ts-check

const { parseJSONMessage, runCodex, truncate } = require('./codex.cjs');

const MAX_PATCH_CHARS = 24_000;
const MAX_OTHER_FILES = 40;

/**
 * @typedef {import('../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../src/types.ts').ReviewAssistantRequest} ReviewAssistantRequest
 * @typedef {{model?: string; fallbackModel?: string; onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void}} CodexOptions
 */

const reviewAssistantSchema = {
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    version: { const: 1, type: 'number' },
  },
  required: ['version', 'reply'],
  type: 'object',
};

/** @param {ChangedFile} file */
const getFileDigest = (file) => ({
  oldPath: file.oldPath,
  path: file.path,
  status: file.status,
  summaries: file.sections
    .map((section) => section.summary?.reason)
    .filter((summary) => typeof summary === 'string' && summary.trim()),
});

/** @param {RepositoryState} state @param {Partial<ReviewAssistantRequest> | null | undefined} request */
const buildReviewAssistantInput = (state, request) => {
  /** @type {Partial<ReviewAssistantRequest['comment']>} */
  const comment = request?.comment ?? {};
  const file = state.files.find((candidate) => candidate.path === comment.filePath);
  const section = file?.sections.find((candidate) => candidate.id === comment.sectionId);

  return {
    comment: {
      body: typeof comment.body === 'string' ? comment.body : '',
      filePath: comment.filePath,
      lineNumber: comment.lineNumber,
      side: comment.side,
      startLineNumber: comment.startLineNumber,
      startSide: comment.startSide,
    },
    focus: file
      ? {
          file: getFileDigest(file),
          patchExcerpt: section
            ? truncate(section.patch || section.summary?.reason || '', MAX_PATCH_CHARS)
            : 'No patch context available.',
          section: section
            ? {
                binary: section.binary,
                kind: section.kind,
                loadState: section.loadState,
                summary: section.summary?.reason,
              }
            : null,
        }
      : null,
    nearbyFiles: state.files
      .filter((candidate) => candidate.path !== comment.filePath)
      .slice(0, MAX_OTHER_FILES)
      .map(getFileDigest),
    root: state.root,
    source: state.source,
    walkthroughNote: request?.walkthroughNote ?? null,
  };
};

/** @param {RepositoryState} state @param {Partial<ReviewAssistantRequest> | null | undefined} request */
const buildReviewAssistantPrompt = (state, request) => `You are Codex inside Codiff.

A human reviewer wrote a rough inline review note and clicked Ask Codex.
Reply as a concise assistant in the same inline conversation.
Use only the repository change digest below; do not inspect the repository or run shell commands.
If there is walkthrough context, use it as review orientation, not as proof.
You are the code-review expert in this conversation, so explain the change directly.

Your job:
- Turn vague unease into coherent, actionable review feedback.
- If the note asks "why", explain why this change is needed based on the diff.
- If useful, suggest a clearer review comment the human could use.
- Prefer questions and concrete risks over accusations.
- Do not hedge. Avoid words and phrases like "appears", "seems", "might", "likely", "probably", "I think", "I suspect", and "the intent".
- Say "This change introduces...", "This change moves...", or "This is needed because..." instead of "This change appears to...".
- If the diff does not provide enough evidence, state the concrete uncertainty after the explanation.
- Do not say the change is correct unless the diff proves it.
- Do not invent bugs, unstated requirements, or files outside the digest.
- Keep the reply under 180 words.
- Markdown is allowed.

Repository change digest:
${JSON.stringify(buildReviewAssistantInput(state, request), null, 2)}
`;

/** @param {unknown} value @param {string} [fallback] */
const cleanReply = (value, fallback = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\n{3,}/g, '\n\n').trim();

/** @param {unknown} input */
const normalizeReviewAssistantReply = (input) => ({
  reply: cleanReply(
    input && typeof input === 'object' && 'reply' in input ? input.reply : undefined,
    'Codex could not produce a useful reply.',
  ),
  version: 1,
});

/**
 * @param {RepositoryState} state
 * @param {ReviewAssistantRequest} request
 * @param {CodexOptions} codexOptions
 */
const readReviewAssistantReply = async (state, request, codexOptions) => {
  try {
    const response = await runCodex(
      state.root,
      buildReviewAssistantPrompt(state, request),
      reviewAssistantSchema,
      'review-assistant.json',
      'Codex review reply timed out.',
      codexOptions,
    );
    const parsed = parseJSONMessage(response);

    return {
      reply: normalizeReviewAssistantReply(parsed).reply,
      status: 'ready',
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        reason:
          'Codex is not installed locally. Install and use Codex, then ask from this comment again.',
        status: 'unavailable',
      };
    }

    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

module.exports = {
  buildReviewAssistantInput,
  buildReviewAssistantPrompt,
  normalizeReviewAssistantReply,
  readReviewAssistantReply,
  reviewAssistantSchema,
};
