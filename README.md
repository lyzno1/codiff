# Codiff

Codiff is a beautiful, minimal, local diff viewer for reviewing staged and unstaged Git changes before committing.

<img width="2824" height="1856" src="https://github.com/user-attachments/assets/9f739a48-82f6-408a-8324-a845741fb190" />

## Why Codiff

- **Fast Local Reviews:** See changes in any Git repository to review code before committing.
- **LLM Walkthroughs:** Run `codiff -w` to ask Codex to give your a review order and more context.
- **Inline Review Comments:** Comment directly on changed lines and copy all review comments as Markdown for follow-ups.

## Download

Download the latest Codiff app from [GitHub Releases](https://github.com/nkzw-tech/codiff/releases).

After installing the app, run `Codiff > Install Terminal Helper` to make the `codiff` command available in your shell.

## Command Line

```bash
codiff
```

Run it from any Git repository, or pass a path:

```bash
codiff /path/to/repository
```

Review a specific commit:

```bash
codiff a1b2c3d
```

Start with an LLM-generated walkthrough order:

```bash
codiff -w
codiff -w a1b2c3d
```

Launching Codiff in multiple repositories opens a separate native window for each repository.

## Development

```bash
vp install
vp build
vpr codiff
```

For live development:

```bash
vpr dev
ELECTRON_RENDERER_URL=http://127.0.0.1:5173 vpr electron
```

Useful checks:

```bash
vp check
vp test
vp build
```
