#!/usr/bin/env bash
# Re-record the README demos: docs/demos/record.sh [first-call|teach-once|research|pull-call|safety|mentions ...]
# Needs vhs (brew install vhs), jq, Google Chrome, network access, and for the research demo an
# existing LinkedIn session in ~/.api-anything (api-anything login linkedin). State goes to
# /tmp/api-anything-demo; ~/.api-anything is only read. Run the tapes in order: 2 and 3 reuse 1's install;
# pull-call, safety and mentions run this checkout's build, and safety starts the local fixture site (needs npm ci).
set -euo pipefail
cd "$(dirname "$0")/../.."
export DEMO_REPO="$PWD"
npm run build --silent   # examples/ import this checkout's dist

for name in "${@:-first-call teach-once research pull-call safety mentions}"; do
  for tape in $name; do
    vhs "docs/demos/$tape.tape"
    # VHS writes every frame; keep the last frame before each clear, and the final one.
    node -e '
      const fs = require("fs"), f = process.argv[1];
      const frames = fs.readFileSync(f, "utf8").split(/^─+$/m)
        .map((s) => s.split("\n").map((l) => l.trimEnd()).join("\n").trim()).filter((s) => !/^[>$\s]*$/.test(s) && !s.includes("export PS1="));
      const first = (s) => s.split("\n")[0];
      const kept = frames.filter((s, i) => i === frames.length - 1 || first(frames[i + 1]) !== first(s));
      fs.writeFileSync(f, kept.join("\n\n") + "\n");
    ' "docs/demos/$tape.txt"
    if [ "$tape" = research ]; then cp /tmp/brief.json docs/demos/research-brief.json; fi
  done
done
