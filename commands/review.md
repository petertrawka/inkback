---
description: Open a localhost page with drawing and note tools; what you mark comes straight back into this session
argument-hint: <url> [--push] | pull | clear | close
---

The user wants to give visual feedback on a running page. Arguments: `$ARGUMENTS`

**Keep the mechanics out of the terminal.** No talk of injecting, screenshots,
Playwright, channels, polling or tools. Two lines at most while opening, then
one calm waiting line, then silence until something arrives.

## Dispatch on the argument

- `pull` → call `inkback_pull` and handle what it returns (see below). If it says empty, tell the user to hit Send on the page.
- `clear` → call `inkback_clear`, confirm in one line.
- `close` → call `inkback_close`, confirm in one line.
- A URL → call `inkback_open` with that url. Use `delivery: "channel"` only if `--push` was given (optional faster mode, needs the session to have been started with the channel flag); otherwise use `delivery: "poll"`. `--poll` is accepted and means the same as no flag. Then say one line: the page is open, draw and drop notes, hit **Send to Claude** when ready.
- Nothing → ask for the URL in one line.

## Waiting (default, no startup flag needed)

After `inkback_open` in poll mode, say exactly one calm line, for example
"Waiting for your notes. Draw on the page and press Send to Claude.", then call
`inkback_wait` right away. Say nothing more while it waits. If it returns
`timeout`, call it again silently. If it returns `closed`, the user pressed
"Looks good, close" or shut the window: stop, with no extra message. In `--push`
mode do not wait: a channel event arrives by itself.

## When annotations arrive

They come as the result of `inkback_wait` / `inkback_pull`, or (with `--push`)
as a `<channel source="…inkback" …>` event. All have the same shape: pages,
numbered notes with the user's text and the element under the pin (selector,
text, React components, source file when known), marks (strokes, arrows, lines,
boxes, circles) with what they point at, and PNG paths.

1. `Read` every PNG path listed. Crops first, the overview for context.
2. Say one short line: what you're going to change.
3. For each note in order: `inkback_progress(note, "working")`, make the change
   in the code, then `inkback_progress(note, "done", <one short line>)`. If a
   note can't or shouldn't be done, `inkback_progress(note, "skipped", <why>)`.
4. Marks without a note describe what they point at. Act on them too.
5. If the dev server hot-reloads, you may call `inkback_screenshot` to check.
6. Finish with `inkback_done(summary)`: one or two sentences, only after every
   edit is saved. It retakes each marked spot and shows the user a before/after
   view with two buttons: "Looks good, close" (ends the round, closes the window)
   and "More feedback" (keeps the window open for another round).
7. One short closing line in the terminal. In poll mode, then call
   `inkback_wait` again silently for the next round.

Use `inkback_reply` for a question you can't resolve yourself; it shows as a
toast on the page. Prefer a sensible assumption over a question.

## If Send never arrives

If the user says they hit Send and nothing came in, call `inkback_pull`. If it
returns a batch, handle it (in `--push` mode this means the session was started
without the channel flag: tell the user once to use plain
`/inkback:review <url>` instead).
