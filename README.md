# Inkback

**Draw it. See it done.**

Inkback is a Claude Code plugin for visual feedback on your running app. Comment and sketch right on the page, press **Send to Claude**, and Claude edits the code. When it's done, every note comes back with a before/after slider.

## What it does

- **Comment anywhere.** Double-click to leave a note. Paste or drop up to 4 reference images into it.
- **Ink brush pen.** Strokes thin out when you draw fast and taper at both ends, in a sage-to-gold gradient. Every stroke opens a linked comment.
- **Spotlight areas** (key `A`). Drag a box and the rest of the page dims while you write.
- **Send to Claude.** Your notes, the element under each one (with its React component and source file when known) and screenshots land in your Claude Code session.
- **Before / after.** When Claude finishes, each spot comes back with a slider. The "after" picture follows the element even if content above it moved.
- **Two endings.** *Looks good, close* ends the round and closes the window. *More feedback* reloads the page for another round.
- **Local only.** It runs on your machine in its own Chrome window. No cloud, and no AI calls beyond your Claude session.

## Install

```text
/plugin marketplace add petertrawka/inkback
/plugin install inkback@inkback
```

Then, with your app running:

```text
/inkback:annotate http://localhost:3000 --poll
```

Needs Node 20+ and Google Chrome. It works on local addresses only (localhost, 127.0.0.1, *.local, *.test).

## Credits

Inkback is built on [claude-annotate](https://github.com/FinalAngel/claude-annotate) by Angelo Dini, released under the MIT licence. The browser bridge, element context and Send loop are his. Inkback adds its own look, pen, spotlight areas and before/after review. The original documentation is in [docs/](docs/).

MIT licence, see [LICENSE](LICENSE).
