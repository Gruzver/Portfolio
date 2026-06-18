# Portfolio — RL Arm

Single-page personal portfolio with a live reinforcement-learning simulation in
the left column and your bio / projects / contact in the right column.

The left panel runs a **REINFORCE** policy-gradient agent (implemented from
scratch in vanilla JS, no ML libraries) that learns to drive a 2-DOF robotic arm
to press a button in the lower-right "table" zone. Training runs continuously in
a Web Worker; each demo runs the **latest** model, so every run reflects more
training than the last — you watch the policy go from flailing early on to
reliably pressing the button as the episode count climbs.

## Files

| File         | Purpose                                                         |
|--------------|-----------------------------------------------------------------|
| `index.html` | Layout, styling, canvas rendering, charts, sliders, demo reel   |
| `worker.js`  | The RL agent: MLP policy, manual backprop, mini-batch REINFORCE |
| `.nojekyll`  | Tells GitHub Pages to serve files as-is                         |

No build step, no dependencies. Just static files.

## Customize

Open `index.html` and replace every `<!-- PLACEHOLDER -->` comment:

- **Name / role / bio** — in the `.hero` section
- **Photo** — swap the `.hero-avatar-placeholder` for `<img class="hero-avatar" src="your-photo.jpg"/>`
- **Projects** — three `.project-card` blocks (title, description, tags, image)
- **Research / publications** — `.pub-item` blocks
- **Contact** — email, LinkedIn, GitHub links
- **GitHub / résumé buttons** and the page `<title>`

Colors and fonts follow a monochrome "technical paper" design system defined in
the `:root` CSS variables.

## Run locally

Web Workers don't run from `file://`, so use a local server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a repo named `your-username.github.io` (or any repo + project pages).
2. Push these files to the default branch.
3. In **Settings → Pages**, set the source to that branch, root folder.
4. Your site goes live at `https://your-username.github.io`.

## Notes

- On screens narrower than 768px the simulation panel is hidden (the worker is
  never spawned) and only the content column is shown.
- The agent genuinely trains the whole time the tab is open; there is no pause
  or reset button by design.
