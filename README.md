# pr-tools

`prs` is a terminal UI for your open pull requests: CI state, approvals, unresolved review threads, who still has to review, with one-click actions.

```sh
~/dev/pr-tools/prs                 # repos from ~/.config/prs/config.json
~/dev/pr-tools/prs --interval 30   # refresh cadence in seconds
~/dev/pr-tools/prs owner/repo other/repo
~/dev/pr-tools/prs --json          # machine-readable, no UI
~/dev/pr-tools/prs nudge [PR]      # copy the Slack review request for a PR
~/dev/pr-tools/prs rerun <PR>      # rerun the failed CI jobs of a PR
ln -s ~/dev/pr-tools/prs ~/.local/bin/prs
```

Runs on [Bun](https://bun.sh); OpenTUI (`@opentui/react`, React 19) renders the UI.

## In the UI

- Cards flow into a grid of one to three columns depending on terminal width and reflow on resize. Border colour: green CI, yellow running, red when CI failed, a thread is unresolved or the branch conflicts.
- Each card ends with buttons. Click `[ nudge ]` to copy the Slack review request (`Hi! @team-a, @team-b, could you please review <url>`), click `[ rerun CI ]` on a red card to rerun only its failed jobs; the card shows "requesting rerun…" and polls until the checks leave the failed state. Clicks need a terminal with xterm mouse reporting (Ghostty, iTerm2, kitty, WezTerm, Terminal.app).
- `[ merge ]` runs `gh pr merge --auto`: it adds the PR to the merge queue when checks pass, or enables auto-merge until they do. The card then shows "in merge queue" or "auto-merge on" and hides the button.
- Keyboard: `[1-9]` then `n`, `c` or `m` does the same, `r` refreshes now, `q` quits.
- PR links are OSC 8 hyperlinks.

Configuration lives in `~/.config/prs/config.json`:

```json
{
  "repos": ["owner/repo"],
  "interval": 120
}
```

`repos` are used when none are passed on the command line and `interval` is the refresh cadence in seconds. The nudge message tags pending teams by their GitHub slug without the org prefix (`org/foo` becomes `@foo`).

`prs.sh` is the previous bash implementation, kept for reference.
