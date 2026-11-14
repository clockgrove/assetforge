# Assetgrove Viewer PRD

The Assetgrove viewer is an MCP App that lets a developer see, compare and pick assets inside the harnesses that can draw one. It renders only from `asset://` addresses, the same tree the agent and the CLI already use.

- **When it comes:** after 1.0, once outside developers have used Assetgrove without a UI and said what they need. Their feedback decides which views come first. 1.0 itself shows contact sheets and preview files ([Assetgrove 1.0 PRD](PRD.md#how-the-developer-sees-and-confirms)).
- **What it builds on:** the `asset://` tree from core Assetgrove: asset cards and the views that need no index. With the search add-on installed, the viewer also gets the search paths ([Assetgrove Search PRD](PRD-search.md)).
- **What it adds:** drawing. It brings no data store, no search and no actions of its own. Reading is a resource read; acting is a tool call with its usual confirmation.
- **Where it shows:** in harnesses that draw MCP Apps. Elsewhere, including Claude Code in a terminal, developers keep the contact sheets they already have.

## Principles

1. **Feedback first.** No view is built until outside developers have used the no-UI release and asked for it. Reason: a UI is a rabbit hole, and their feedback says which hole is worth it.
2. **The tree is the only data source.** Every pixel the viewer draws comes from an `asset://` read. Reason: the agent, the CLI and the viewer can never disagree about what exists.
3. **Actions are tools.** Picking, rejecting, editing a card and approving spend go through the same tools, and the same confirmations, as everywhere else. The viewer is not a way around them.
4. **No second chat.** A note the developer writes in the viewer goes to the agent's conversation. There is no model, key or chat inside the viewer.
5. **Nothing hosted.** The viewer is served by the developer's own Assetgrove server, through their harness. There is no website and no account.

## Where it runs

The viewer shows only where the harness draws MCP Apps. Support changes month to month; this is as of 2026-11-13, and the build checks each host again.

| Harness                                   | Draws MCP Apps            | What its users get                                                                            |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| Claude desktop app and claude.ai          | Yes                       | The viewer inline in the conversation                                                         |
| Cursor                                    | Yes                       | The viewer inline                                                                             |
| Goose                                     | Yes                       | The viewer inline                                                                             |
| VS Code with Copilot                      | Experimental, inline only | The viewer inline; no fullscreen. Notes from the viewer fill the chat box rather than sending |
| Claude Code, terminal and remote sessions | No                        | Contact sheets and preview files, as in 1.0                                                   |
| Codex                                     | Not confirmed             | Contact sheets until confirmed                                                                |

One question stays open: whether Claude Code users should also get the viewer as a page on their own machine, opened from the harness.

## How it reads the tree

The MCP Apps specification lets an App call its server's tools and read its resources through the host (`tools/call` and `resources/read`). It gives Apps no listing call. The viewer is designed around exactly that.

| The viewer wants to               | It does                                                | Example                                  |
| --------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| Show an asset                     | Reads the asset's address                              | `asset://fern-quest/lantern-porch/image` |
| Show its record                   | Reads its card and provenance                          | `asset://fern-quest/lantern-porch/card`  |
| Browse a folder                   | Reads the folder's address, which returns its children | `asset://fern-quest/by-kind/prop`        |
| Search                            | Reads a search path (needs the search add-on)          | `asset://fern-quest/like/lantern-porch`  |
| Show a run's candidates           | Reads the run folder                                   | `asset://fern-quest/runs/<run>`          |
| Pick, reject, edit, approve spend | Calls the tool, which asks for its confirmation        | `pick` with the candidate's address      |

- **One rule for the tree:** every folder address is readable and returns its children. Core Assetgrove keeps that rule from the start, so the viewer needs nothing added to the tree.
- **Large files:** the viewer reads a thumbnail first and the full file only when asked, so a large library stays quick.

### The data model

The viewer draws the same files core Assetgrove writes into the game's repository: an Open Knowledge Format bundle of asset cards (defined in the [Assetgrove Search PRD](PRD-search.md#asset-cards)), plus each asset's review record. It has no model of its own, so anything the viewer shows can also be read in a text editor, by the agent, or in any OKF tool.

| What the viewer shows                                 | Read from                                                                  | OKF part                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| The asset                                             | The card's `resource`                                                      | The concept's resource                                            |
| Name, summary, tags                                   | `title`, `description`, `tags`                                             | Recommended fields                                                |
| Trust badge: candidate, passed QA, picked by a person | `verified` entries                                                         | Trust tiers derived from `verified`                               |
| How it was made                                       | `generated` and the provenance record in `sources`                         | Trust and provenance fields                                       |
| Subject, state, bible version, licence                | Assetgrove's own card fields                                               | Extension fields                                                  |
| Notes about the asset                                 | The card's body                                                            | The concept body                                                  |
| A folder of assets                                    | The folder's `index.md`, which is also what its `asset://` address returns | Index files                                                       |
| What changed in a folder                              | The folder's `log.md`                                                      | Log files                                                         |
| Annotations, comments, decisions, change requests     | `<asset>.review.json`                                                      | Outside OKF: W3C Web Annotation, linked from the card's `sources` |

- **Editing in the viewer edits these files.** Changing a description or adding a tag is a tool call that rewrites the card, and the log gains a line, the same as an edit from the agent or the CLI.
- **The record panel is the card.** Its sections are the card's fields and body, so a developer's own extra fields show up without any viewer change.
- **The history panel is the log,** so a folder's recent changes show without walking Git.

## The layout

Every asset opens in the same layout: the asset in the middle, its record on the right, and actions that go back to the agent. It is a common review-tool layout, designed from Assetgrove's own needs.

| Part                   | What it does                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proportions            | The asset takes about 80% of the width, the record about 20%. The record panel collapses, and starts collapsed in a narrow chat pane                                                                                                                                                                                                                                                            |
| Centre                 | A renderer per format, chosen by the file's type, so a new asset kind adds a renderer and nothing else: large images (pan, zoom, 1:1 pixels for pixel art, a transparency checkerboard); animations (play, scrub, speed, the loop seam); tile sets (tiled 3×3 so seams and repeats show); 3D (orbit, light, detail levels, motions); audio, when Assetgrove makes it (playback with a waveform) |
| Record panel           | Collapsible sections, each read from the card (an OKF concept) and its provenance: request (prompt, route, model, seed, cost), style (bible version), quality (QA results), provenance (who picked it, how it was confirmed, the provider's terms), export (engine paths) and state (candidate, picked, locked, out of date)                                                                    |
| Notes to the agent     | The developer selects an asset, or a region of it, and types. The App puts the note into the conversation (`ui/message`) and the selection into the agent's context (`ui/update-model-context`)                                                                                                                                                                                                 |
| Actions                | Pick, reject with a reason, variations, another round with a note, each a tool call                                                                                                                                                                                                                                                                                                             |
| Text from shared files | Shown as plain text, never rendered as Markdown or run                                                                                                                                                                                                                                                                                                                                          |

## Review and approval

Review is the viewer's centre. It takes what studio review tools have converged on, keeps what a solo developer choosing among generated candidates actually uses, and adds what game art needs and those tools lack. The survey covered SyncSketch, Flow Production Tracking, ftrack, Frame.io, Filestage, Ziflow, Figma, Miro and cineSync, plus how AI image editors let you point at a region and ask for a change.

| #   | Feature                          | What the developer does                                                                        | Who has it today                                            |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Candidate grid                   | Picks and rejects among a run's candidates from the keyboard, beside the references            | AI image tools' variant grids                               |
| 2   | Region change request            | Draws a box or brushes a mask, types what should change, adds more regions before sending      | Krea, Midjourney, ChatGPT, Photoshop                        |
| 3   | Version stack with four statuses | Sees every version of an asset; each is pending, changes requested, approved or rejected       | Filestage, ftrack, SyncSketch, Ziflow                       |
| 4   | Compare to the last version      | Side by side, an A/B toggle, or a wipe slider                                                  | Every review tool has side by side; cineSync has the slider |
| 5   | True-pixel viewing               | Zooms with hard pixel edges on a checkerboard or a chosen background                           | None; game art needs it                                     |
| 6   | Animation review                 | Plays, steps frame by frame, loops, sets the speed, turns on onion skin, comments on one frame | SyncSketch, ftrack, Flow                                    |
| 7   | Reference on a request           | Attaches an image to show rather than describe                                                 | Frame.io, Krea, Photoshop                                   |
| 8   | Paintover                        | Draws freehand over the asset; strokes can double as the edit mask                             | Most review tools                                           |
| 9   | 3D notes                         | Pins a note to a point on the model, with the camera saved, and plays its clips                | Only SyncSketch                                             |
| 10  | Tile and game-scale preview      | Repeats a tile 3×3 to show seams; sees the asset at game size on a sample background           | None; game art needs it                                     |

- **Comments:** each annotation carries a comment, replies, and a resolved state. A thread records which version answered it.
- **Deliberately left out:** mentions, reactions, multi-step approval, due dates, checklists, live review sessions, share links and notifications. A solo developer has no one to route them to, the agent's conversation already notifies, and Git already keeps the history.

### Where reviews are kept

Every annotation, comment, decision and change request is stored in the W3C Web Annotation format, a published W3C standard, as `<asset>.review.json` next to the asset, with any brush masks as PNG files beside it.

- **Regions** use percentage coordinates, so a box still points at the same place after a version comes back at a different size. Freehand shapes are SVG.
- **Frames and 3D** need two small extensions the standard doesn't define: a frame index for sprite animations, and a point, normal and camera for a 3D pin.
- **Picked assets'** reviews are committed beside them, so the history travels with the asset. **Candidates'** reviews stay in the run folder with the candidates.
- **The tree serves them** at `asset://<game>/<asset>/review`, so the agent and the CLI read the same review the viewer draws.

## Change requests

A change request turns a review comment into work for Assetgrove: the developer marks what's wrong, Assetgrove makes a new version, and the new version comes back into the same review beside the old one. The request is a core Assetgrove tool, so it works from the agent and the CLI too; the viewer only makes it easy to draw.

1. **Mark it.** The developer draws a box or brushes a region on an asset, on one frame of an animation, or on one view of a 3D turntable. Each region gets a numbered card with what should change, an optional reference image, and a "keep everything else" switch. Several regions go in one request.
2. **Request it.** The viewer calls Assetgrove's `request_change` tool with the asset's address, its version, the region, the frame or view, the note and any references. The same tool takes the same fields as text from the agent or the CLI, so a developer without the viewer can still say "box 120,80,64,64 on candidate 3: tail tip darker".
3. **Plan and confirm.** Assetgrove turns the request into a job: a masked edit of that region when the route supports one, or another round with the note when it doesn't. The forecast goes to the developer for the usual spend confirmation.
4. **Make the version.** The job runs, QA checks the result, and the new version joins the asset's version stack. The request's comment thread records which version addressed it.
5. **Bring it back.** The viewer learns of the new version from the tool's result and by reading the asset's address again, then opens old and new in compare. Compare is essential here: image models treat a mask as guidance, not an exact boundary, so a change can spill outside the region. The agent and other clients that subscribe to the asset's resource are told it changed.
6. **Decide.** The developer approves the new version, asks for another change, or resolves the comment.

- **The agent stays in the loop.** The request also lands in the conversation as a note, so the agent can refine it, batch several requests into one job, or ask a question before spending.
- **Requests are records.** Each one is saved with the asset's review: region, note, references, the version it was made on and the version that answered it. That history is what makes "why does this look like this?" answerable later.
- **A limit of the App spec:** an MCP App can call tools and read resources, but the spec doesn't let it subscribe to resource changes. So the viewer refreshes from tool results and re-reads; subscriptions serve the agent and the CLI.

## Views to choose from

These are candidates, not a plan. Outside developers' feedback picks the first ones; each is a set of reads from the tree drawn a particular way.

| View              | What it shows                                                                                                                       | Reads                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Review            | A run's candidates beside the references, with pick and reject                                                                      | The run folder and the bible's references |
| Spend card        | The planned jobs, the candidate count, the forecast and the cap, with Approve. Approval carries the server's own digest of the plan | A plan resource; Approve is a tool        |
| Compare           | Two assets, or before and after a replacement, side by side or with a slider                                                        | Two asset addresses                       |
| Game scale        | An asset at its in-game size beside approved assets from its set                                                                    | The asset and its set's folder            |
| Library           | Every asset in a game, filtered by kind, subject, tag or state                                                                      | The tree's folders                        |
| Search            | Results of a search by words, by look or by fields                                                                                  | A search path (search add-on)             |
| Style bible board | The bible's looks, references and mood board, side by side                                                                          | The bible's resources                     |

## 3D and other limits inside an MCP App

An MCP App runs in a sandboxed frame, and its default content policy shapes what the viewer can do. These need a spike with pass numbers before 3D is promised.

- **No WebAssembly and no `blob:` addresses by default.** So the usual compressed-mesh and texture decoders won't run. The viewer loads uncompressed models, parsed from bytes rather than fetched from a URL.
- **Binary data travels as text.** A model or image read through the host arrives encoded as text and passes through the harness, so large files are slow. Thumbnails first, full files on request, and models sized for viewing rather than the full asset.
- **Detail levels are drawn by the viewer itself.** Common 3D libraries don't read the detail-level extension Assetgrove writes.
- **Some looks can only be judged in the engine,** such as fur from groom maps. The viewer says so rather than showing a misleading render.
- **Hosts may cap size and memory.** The spec sets no limit, but hosts may; the spike measures each target host.

If the spike misses, 3D stays on turntable previews and the viewer covers 2D.

## What it's built with

Off-the-shelf parts, per Assetgrove's rule to use what exists:

| Part                                                | Use                                                                                       | Why                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The MCP Apps SDK (`@modelcontextprotocol/ext-apps`) | Serving the App and talking to the host                                                   | The official SDK for the extension                                            |
| Preact                                              | The interface                                                                             | Small enough for a single-file App                                            |
| three.js                                            | 3D: orbit, light, animation playback                                                      | The common choice; works inside the sandbox when models are parsed from bytes |
| A single-file bundler (vite-plugin-singlefile)      | Packing the App into one HTML file                                                        | An App is served as one resource                                              |
| A small pan-and-zoom library, or our own            | Large images                                                                              | A few kilobytes                                                               |
| Annotorious, with its tools plugin                  | Region boxes and shapes on images, reading and writing the W3C annotation format directly | BSD-3-Clause, about 49 KB compressed with the plugin                          |
| Konva, with perfect-freehand                        | Brush masks, paintover, onion skin, wipe compare and frame playback on a canvas           | MIT, about 59 KB compressed together                                          |

The viewer ships as its own package on top of Assetgrove, like the search add-on, so a developer who never uses an App host doesn't install it.

## Trust

| The viewer            | Rule                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Can read              | Only `asset://` resources from the developer's own Assetgrove server                                                                                                           |
| Can act               | Only by calling tools; each pick or spend still asks for the developer's confirmation, and the tool can tell an App's call from the agent's only as far as the host reports it |
| Can reach the network | No. The App runs with the host's default policy, which blocks network access                                                                                                   |
| Shows shared text     | As plain text only, so a style bible or card from someone else can't run script inside it                                                                                      |
| Holds keys            | Never. Keys stay in the developer's environment and Assetgrove's server                                                                                                        |

## Non-goals, measures and risks

**Non-goals:** no editor for art; no data store, search or actions of its own; no website or account; no view built before outside developers ask for it.

| Measure                                      | Bar                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The viewer shows only what the tree holds    | A test compares every view against the same reads made by the CLI                               |
| It works in the hosts it claims              | Each claimed host passes a scripted check of reading, browsing, picking and a note to the agent |
| Picks made in the viewer still need a person | The tool's confirmation fires for a viewer pick in every claimed host                           |
| Large libraries stay usable                  | A folder of 1,000 assets opens and scrolls without waiting on full-size files                   |

| Risk                               | How we handle it                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Host support changes or stays thin | Contact sheets remain the baseline in every harness; the viewer is an addition                     |
| 3D doesn't fit inside an App       | The spike decides; turntable previews are the fallback                                             |
| The viewer grows its own logic     | Principle 2: every view is reads from the tree; anything else is a change to core Assetgrove first |

## Open questions

To answer before building:

- whether Codex draws MCP Apps;
- each target host's limits on size and memory for an App, and whether it relays resource reads;
- whether a tool can tell a call from the App apart from a call from the agent, in each host.
