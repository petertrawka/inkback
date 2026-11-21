# Inkback

**Mark what's wrong on your running app, and get proof of what Claude changed, including what you didn't ask for.**

For people building with Claude Code in the terminal or VS Code. Local, no account.

![Inkback's result screen for a ceramics shop page, headed "1 changed · 1 also changed". Note 1, "Make this the main button", is marked Changed with Claude's line "Turned the link into a solid button." The before/after slider splits the spot down the middle: the user's indigo pen circle around a faint "Shop the collection" link on the Before side, a solid black button on the After side.](assets/inkback-hero.png)

## Install

```text
/plugin marketplace add petertrawka/inkback
/plugin install inkback@inkback
```

Then, with your app running, run `/inkback:review http://localhost:3000` in Claude Code. No special flags.

## What it does

Draw and comment right on the page, press **Send to Claude**, and Claude edits the code. When it's done, every note comes back with a before/after slider and one label: *Changed*, *No visible change* or *Couldn't check*. Anything else on the page that changed shows up under *Also changed*.

- **Ink brush pen.** Circle what needs changing. Strokes taper like a real pen, in indigo with a soft white halo, so they read on light and dark pages. Every stroke opens a linked note.
- **Comment anywhere.** Double-click to leave a note. Paste or drop up to 4 reference images into it.
- **Spotlight areas** (key `A`). Drag a box and the rest of the page dims while you write.
- **Send to Claude.** Your notes, the element under each one (with its React component and source file when known) and screenshots land in your Claude Code session.
- **Before / after.** Each spot comes back with a slider. The "after" picture follows the element even if content above it moved.
- **Also changed.** Inkback compares the whole page after each round. Areas that changed away from your notes are boxed and listed, each with its own slider.
- **Ink back.** Your own pen marks and note numbers come back with the result: on the Before picture where you drew them, and as a small copy on each card.
- **Not right.** Every result has a *Not right* button. The next round starts with a ready-made note on each spot you picked ("Put this back the way it was", before picture attached) and your drawing back on the page. Edit it or add more, then Send.
- **Two endings.** *Looks good, close* ends the round. *More feedback* reloads the page for another round.
- **First use.** The first time, Inkback opens with the pen ready and one quiet line in the toolbar ("Circle what needs changing", then "Send it. See it back."). It's gone after your first finished round.
- **Local only.** It runs on your machine in its own Chrome window. No cloud, and no AI calls beyond your Claude session.

**Limits:** Google Chrome and Node 20+ only. Local addresses only (localhost, 127.0.0.1, *.local, *.test). A returned pen mark follows its element, but can sit slightly off after the page reflows.

## How to use it

With your app running, start Claude Code as usual (no special flag) and run:

```text
/inkback:review http://localhost:3000
```

Claude says it is waiting. Draw, add notes, press **Send to Claude**, and Claude edits your code.

## Credits

Inkback is built on [claude-annotate](https://github.com/FinalAngel/claude-annotate) by Angelo Dini, released under the MIT licence. The browser bridge, element context and Send loop are his. Inkback adds its own look, pen, spotlight areas and before/after review.
MIT licence, see [LICENSE](LICENSE).
