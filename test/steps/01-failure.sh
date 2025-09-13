#!/bin/sh

set -e

cd "$(dirname "$0")"

(curl -sX POST "http://localhost:${MANAGE_PORT}/redeploy-non-active" && echo) >> ../log.jsonl
sleep 1
(curl -s "http://localhost:${MANAGE_PORT}/status" && echo) >> ../log.jsonl
curl -fso /dev/null "http://localhost:${ACTIVE_PORT}/log/7"
curl -fso /dev/null "http://localhost:${NON_ACTIVE_PORT}/log/8"
(curl -sX POST "http://localhost:${MANAGE_PORT}/swap" && echo) >> ../log.jsonl
sleep 1
(curl -s "http://localhost:${MANAGE_PORT}/status" && echo) >> ../log.jsonl
curl -fso /dev/null "http://localhost:${ACTIVE_PORT}/log/9"
curl -fso /dev/null "http://localhost:${NON_ACTIVE_PORT}/log/10"
