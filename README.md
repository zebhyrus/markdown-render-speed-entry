# markdown-render-speed-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zebhyrus/markdown-render-speed-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zebhyrus/markdown-render-speed-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, single-pass Markdown parser written from scratch for speed. It renders CommonMark 0.31.2 plus the GFM extensions (tables, task lists, strikethrough, extended autolinks, disallowed raw HTML) to byte-identical HTML with marked 18.1.3's defaults, using a line-based block parser and a delimiter-stack inline parser with fast paths for plain paragraphs, so it runs noticeably faster than marked on large documents.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=/home/hatch/workspace/makefun/markdown-render-speed-02-kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9srzvfjv&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
