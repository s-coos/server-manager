#!/bin/sh

set -e

cd "$(dirname "$0")"

additional_git_server_delay=${ADDITIONAL_GIT_SERVER_DELAY:-1}
image_name=${IMAGE_NAME:-server-manager}
active_port=${ACTIVE_PORT:-4000}
non_active_port=${NON_ACTIVE_PORT:-4001}
manage_port=${MANAGE_PORT:-9090}
git_port=${GIT_PORT:-12345}
container_name=${CONTAINER_NAME:-server-manager-test-container}

docker build -t "${image_name}" ..

pkill -f "http-server.*${git_port}" 2>/dev/null || true

rm -rf bare.git log.jsonl worktree workdir logs
git init --bare bare.git
git -C bare.git update-server-info
cat > bare.git/hooks/post-update <<'SH'
#!/bin/sh
exec git update-server-info
SH
chmod +x bare.git/hooks/post-update
git clone bare.git worktree
git -C worktree config user.name "test"
git -C worktree config user.email "test@example.com"
cp -r snapshot/* snapshot/.gitignore worktree/

trap 'docker stop "${container_name}" || true ; rm -rf bare.git tmp.txt log.jsonl worktree workdir logs' EXIT INT TERM

if command -v setsid >/dev/null 2>&1; then
  setsid npx -y http-server -p "$git_port" -c-1 . >/dev/null 2>&1 &
else
  npx -y http-server -p "$git_port" -c-1 . >/dev/null 2>&1 &
fi
GIT_SERVER_PID=$!
[ -n "$GIT_SERVER_PID" ] || { echo "failed to start server"; exit 1; }
PGID=$(ps -o pgid= -p "$GIT_SERVER_PID" | tr -d ' ')
[ -n "$PGID" ] || PGID=$GIT_SERVER_PID

trap "/bin/kill -9 -- -$PGID 2>/dev/null || true ; docker stop "${container_name}" || true ; rm -rf bare.git tmp.txt log.jsonl worktree workdir logs" EXIT INT TERM

fail_count=0
while ! curl -fsS "http://localhost:${git_port}/" > /dev/null; do
  echo "Waiting for git server to start..."
  sleep 1
  fail_count=$((fail_count + 1))
  if [ $fail_count -gt 30 ]; then
    echo "Failed to start git server"
    exit 1
  fi
done
sleep "${additional_git_server_delay}"

# shellcheck disable=SC2012 # no portable find with --maxdepth
ls src-snapshots | sort | while IFS= read -r snapshot; do
  echo "Running step ${snapshot}..."
  sleep 1
  rm -rf "worktree/src"
  cp -r "src-snapshots/${snapshot}" "worktree/src"
  git -C worktree add .
  git -C worktree commit -m "${snapshot}"
  git -C worktree push
  ADDITIONAL_GIT_SERVER_DELAY=${additional_git_server_delay} \
  IMAGE_NAME="${image_name}" \
  ACTIVE_PORT="${active_port}" \
  NON_ACTIVE_PORT="${non_active_port}" \
  MANAGE_PORT="${manage_port}" \
  GIT_PORT="${git_port}" \
  CONTAINER_NAME="${container_name}" \
  sh "steps/${snapshot}.sh"
done

diff -U 3 log.jsonl log-expected.jsonl
diff -U 3 logs/server1.log server1-expected.log
diff -U 3 logs/server2.log server2-expected.log

echo "Tests passed"
