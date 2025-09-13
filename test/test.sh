#!/bin/sh

set -e

cd "$(dirname "$0")"

image_name=${IMAGE_NAME:-server-manager}
active_port=${ACTIVE_PORT:-4000}
non_active_port=${NON_ACTIVE_PORT:-4001}
manage_port=${MANAGE_PORT:-9090}
git_port=${GIT_PORT:-12345}
container_name=${CONTAINER_NAME:-server-manager-test-container}

docker build -t "${image_name}" ..

rm -rf bare.git log.txt worktree workdir logs
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
# trap 'docker stop "${container_name}" ; rm -rf bare.git tmp.txt log.txt worktree workdir logs' EXIT
# shellcheck disable=SC2012 # no portable find with --maxdepth
ls src-snapshots | sort | while IFS= read -r snapshot; do
  rm -rf "worktree/src"
  cp -r "src-snapshots/${snapshot}" "worktree/src"
  git -C worktree add .
  git -C worktree commit -m "${snapshot}"
  git -C worktree push
  IMAGE_NAME="${image_name}" \
  ACTIVE_PORT="${active_port}" \
  NON_ACTIVE_PORT="${non_active_port}" \
  MANAGE_PORT="${manage_port}" \
  GIT_PORT="${git_port}" \
  CONTAINER_NAME="${container_name}" \
  sh "steps/${snapshot}.sh"
done
