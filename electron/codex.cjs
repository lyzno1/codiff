// @ts-check

const { spawn } = require('node:child_process');
const { existsSync, promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const CODEX_TIMEOUT_MS = 45_000;
const DEFAULT_OPENAI_MODEL = 'gpt-5.3-codex-spark';
const FALLBACK_OPENAI_MODEL = 'gpt-5.3-codex';
const CODEX_REASONING_EFFORT = 'high';
/**
 * @typedef {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 * }} CodexOptions
 */
/**
 * @typedef {{
 *   id: string;
 *   label: string;
 * }} OpenAIModel
 */
/** @type {ReadonlyArray<OpenAIModel>} */
const OPENAI_MODELS = Object.freeze([
  {
    id: DEFAULT_OPENAI_MODEL,
    label: 'Best: GPT-5.3 Codex Spark',
  },
  {
    id: FALLBACK_OPENAI_MODEL,
    label: 'Reliable: GPT-5.3 Codex',
  },
  {
    id: 'gpt-5.5',
    label: 'Latest: GPT-5.5',
  },
]);
const OPENAI_MODEL_IDS = new Set(OPENAI_MODELS.map((model) => model.id));

const getCodexCommand = () => {
  if (process.env.CODIFF_CODEX_PATH) {
    return process.env.CODIFF_CODEX_PATH;
  }

  for (const path of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']) {
    if (existsSync(path)) {
      return path;
    }
  }

  return 'codex';
};

/** @param {unknown} value @param {string} [fallback] */
const oneLine = (value, fallback = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\s+/g, ' ').trim();

/** @param {string} value @param {number} maxLength */
const truncate = (value, maxLength) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
};

/** @param {unknown} value @param {string} [fallback] */
const cleanText = (value, fallback = '') =>
  oneLine(value, fallback).replace(/\s*\.{3}\[truncated]$/i, '');

/** @template T @param {unknown} value @param {ReadonlySet<T>} allowed @param {T} fallback */
const normalizeEnum = (value, allowed, fallback) =>
  allowed.has(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;

/** @param {unknown} value @returns {string} */
const normalizeOpenAIModel = (value) =>
  normalizeEnum(value, OPENAI_MODEL_IDS, DEFAULT_OPENAI_MODEL);

/** @param {string} value */
const isOpenAIModelAvailabilityError = (value) =>
  /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model|403|404)\b/i.test(
    value,
  );

/** @param {string} message @returns {unknown} */
const parseJSONMessage = (message) => {
  try {
    return JSON.parse(message);
  } catch {
    const match = message.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('Codex did not return JSON.');
    }

    return JSON.parse(match[0]);
  }
};

/**
 * @param {string} repoRoot
 * @param {string} prompt
 * @param {unknown} schema
 * @param {string} [outputName]
 * @param {string} [timeoutMessage]
 * @param {CodexOptions} [options]
 */
const runCodex = async (
  repoRoot,
  prompt,
  schema,
  outputName = 'codex-output.json',
  timeoutMessage = 'Codex timed out.',
  options = {},
) => {
  const model = normalizeOpenAIModel(options.model);
  const fallbackModel = normalizeOpenAIModel(options.fallbackModel || FALLBACK_OPENAI_MODEL);

  /** @param {string} codexModel @returns {Promise<string>} */
  const invokeCodex = async (codexModel) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'codiff-codex-'));
    const outputPath = join(directory, outputName);
    const schemaPath = join(directory, 'schema.json');
    await fs.writeFile(schemaPath, JSON.stringify(schema), 'utf8');

    return await /** @type {Promise<string>} */ (
      new Promise((resolve, reject) => {
        let stderr = '';
        /** @type {Error | null} */
        let stdinError = null;
        let stdout = '';
        let finished = false;

        const child = spawn(
          getCodexCommand(),
          [
            'exec',
            '-m',
            codexModel,
            '-c',
            `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
            '--cd',
            repoRoot,
            '--sandbox',
            'read-only',
            '--ephemeral',
            '--ignore-rules',
            '--color',
            'never',
            '--output-schema',
            schemaPath,
            '--output-last-message',
            outputPath,
            '-',
          ],
          {
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );

        const timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            child.kill('SIGTERM');
            reject(new Error(timeoutMessage));
          }
        }, CODEX_TIMEOUT_MS);

        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.stdin.on('error', (error) => {
          stdinError = error;
        });
        child.on('error', (error) => {
          finished = true;
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', async (code) => {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(timer);

          if (code !== 0) {
            reject(
              new Error(
                oneLine(stderr || stdout || stdinError?.message, `Codex exited with code ${code}.`),
              ),
            );
            return;
          }

          try {
            const message = await fs.readFile(outputPath, 'utf8');
            resolve(message);
          } catch {
            resolve(stdout);
          }
        });

        child.stdin.end(prompt, () => {});
      })
    ).finally(() => fs.rm(directory, { force: true, recursive: true }).catch(() => {}));
  };

  try {
    return await invokeCodex(model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (model === fallbackModel || !isOpenAIModelAvailabilityError(message)) {
      throw error;
    }

    const response = await invokeCodex(fallbackModel);
    await options.onModelFallback?.(fallbackModel, model);
    return response;
  }
};

module.exports = {
  cleanText,
  DEFAULT_OPENAI_MODEL,
  FALLBACK_OPENAI_MODEL,
  isOpenAIModelAvailabilityError,
  normalizeOpenAIModel,
  normalizeEnum,
  oneLine,
  OPENAI_MODELS,
  parseJSONMessage,
  runCodex,
  truncate,
};
