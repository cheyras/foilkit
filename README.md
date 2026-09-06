# pr-evidence

Render evidence for open pull requests, one directory per pull request.

**This branch is generated and never merges into `main`.** It shares no history with it. The
`PR evidence` workflow force-replaces a pull request's directory on every run; deleting the
whole branch loses nothing but a set of pictures that can be rendered again.

Each strip is an 8-frame tilt sweep produced by `tools/parity/tilt-strip.mjs`, rendered on the
blank card base — never on a card scan, because AGENTS.md F2 means no third-party pixels are
committed anywhere.
