#!/bin/sh

set -e

cd "$(dirname "$0")"

rm -rf ../workdir
mkdir ../workdir
cd ../workdir

git clone ../bare.git server1
git -C server1 remote set-url origin "http://docker-host:${GIT_PORT}/bare.git"
cp ../.env.server1.example server1/.env
git clone ../bare.git server2
git -C server2 remote set-url origin "http://docker-host:${GIT_PORT}/bare.git"
cp ../.env.server2.example server2/.env

(cd server1 && npm i && npm run build)
(cd server2 && npm i && npm run build)

docker run --rm -d \
  --name "${CONTAINER_NAME}" \
  -p "127.0.0.1:${ACTIVE_PORT}:8080" \
  -p "127.0.0.1:${NON_ACTIVE_PORT}:8081" \
  -p "127.0.0.1:${MANAGE_PORT}:9090" \
  -v "$(pwd):/workdir" \
  -v "$(cd .. && pwd)/logs:/var/log" \
  --add-host=docker-host:host-gateway \
  "${IMAGE_NAME}"
fail_count=0
while ! curl -fsS "http://localhost:${MANAGE_PORT}/status" > ../tmp.txt \
  || ! diff ../tmp.txt ../steps/00-initial-status.txt; do
  echo "Waiting for container to start..."
  sleep 1
  fail_count=$((fail_count + 1))
  if [ $fail_count -gt 50 ]; then
    echo "Failed to start container"
    exit 1
  fi
done

curl -fso /dev/null "http://localhost:${ACTIVE_PORT}/log/1"
curl -fso /dev/null "http://localhost:${NON_ACTIVE_PORT}/log/2"
(curl -sX POST "http://localhost:${MANAGE_PORT}/redeploy-non-active" && echo) >> ../log.jsonl
sleep 1
(curl -s "http://localhost:${MANAGE_PORT}/status" && echo) >> ../log.jsonl
curl -fso /dev/null "http://localhost:${ACTIVE_PORT}/log/3"
curl -fso /dev/null "http://localhost:${NON_ACTIVE_PORT}/log/4"
(curl -sX POST "http://localhost:${MANAGE_PORT}/swap" && echo) >> ../log.jsonl
sleep 1
(curl -s "http://localhost:${MANAGE_PORT}/status" && echo) >> ../log.jsonl
curl -fso /dev/null "http://localhost:${ACTIVE_PORT}/log/5"
curl -fso /dev/null "http://localhost:${NON_ACTIVE_PORT}/log/6"
