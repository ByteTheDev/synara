#!/bin/zsh
# usage: server.sh <static-dir> [port] [home-name] [repo]
PORT=${2:-3899}
HOMENAME=${3:-home}
REPO=${4:-/Users/emanueledipietro/Developer/synara/.claude/worktrees/chat-performance-loading-694d73}
P=/private/tmp/claude-501/-Users-emanueledipietro-Developer-synara--claude-worktrees-chat-performance-loading-694d73/6f6980d6-f13e-4cda-8d98-dc1ef2381e0e/scratchpad/perf
rm -rf $P/$HOMENAME && mkdir -p $P/$HOMENAME/userdata && chmod 700 $P/$HOMENAME/userdata && cp $P/state.seeded.sqlite $P/$HOMENAME/userdata/state.sqlite
cd $REPO && exec env -u SYNARA_AUTH_TOKEN SYNARA_HOME=$P/$HOMENAME SYNARA_PORT=$PORT SYNARA_MODE=web SYNARA_NO_BROWSER=1 SYNARA_STATIC_DIR=$1 bun apps/server/src/index.ts
