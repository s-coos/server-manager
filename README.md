# Server Manager

A lightweight **blue/green deployment manager** that bundles:

* **Traefik reverse proxy** (service port)
  * Hot-reloads config when weights change
  * Active HTTP health checks on app processes
* **Node.js management API** (manage port)
  * `POST /redeploy-non-active` =\> rebuild & restart the non-active slot  
  (git pull, npm install/build/test/start)
  * `POST /swap` =\> flip traffic 100% to non-active (only if healthy)
  * `GET /status` =\> inspect weights and health

Both "active" and "non-active" app processes run inside the same container (on localhost:4000 and :4001).
The container exposes two ports:

* **8080** =\> service (user traffic via Traefik)
* **9090** =\> manage API (deployment control)

## Features

* **Zero-downtime cutovers**: switch from active =\> non-active only after health checks pass.
* **In-place redeploy**: kill the old non-active process, `git pull`, `npm i`, `npm run build`, `npm test`, `npm start`.
* **Self-contained**: one container, base image = Node.js; Traefik binary is copied in at build.
* **Hot reload**: Traefik watches `slots.yml` and applies new weights instantly.

## Architecture

```
+------------------------------+
|        Container             |
|                              |
|  Traefik (service :8080)     | ← user traffic
|   └─ reverse_proxy => s-main |
|      ├─ s-server1 => :4000   |
|      └─ s-server2 => :4001   |
|                              |
|  Node.js manager (:9090)     | ← /redeploy-non-active, /swap, /status
|                              |
|  App 1 (npm start :4000)     |
|  App 2 (npm start :4001)     |
+------------------------------+
```

## Getting Started

### 1. Prepare App Workdirs

Prepare workdir with two git worktrees `server1`, `server2` including required configurations such as `.env`.

```sh
mkdir workdir

# possibly with --single-branch --branch <release-branch-name>
git -C workdir clone https://github.com/repo/path.git server1
git -C workdir clone https://github.com/repo/path.git server2

# prepare required configurations if needed
cp workdir/server1/.env.example workdir/server1/.env
cp workdir/server2/.env.example workdir/server2/.env
cp .askpass.sh workdir
```

### 2. Build and Run

```sh
docker build -t server-manager .

docker run -d \
  -p 8080:8080 \                                # active service
  -p 8081:8081 \                                # non-active
  -p 127.0.0.1:9090:9090 \                      # manage API
  -v /abs/path/to/workdir:/workdir \            # workdir
  -e GIT_URL=https://github.com/repo/path.git \ # git url for pull
  # -e GIT_ASKPASS="..." \                      # if needed
  server-manager
```

Traefik will start serving traffic on `http://localhost:8080`.

## Management API

### GET /status

Inspect current weights and health.

```sh
curl http://localhost:9090/status
```

Example:

```json
{
  "server1": true,
  "server2": false,
  "active": "server1",
  "non-active": "server2"
}
```

### POST /redeploy-non-active

Redeploy the non-active slot.

* Kills `npm start` process on non-active slot
* `git pull && npm i && npm run build && npm test && npm start` in `/workdir/server2`
* Check if `/health` passes
* Leaves weight at 0 (or 1 to enable health probing)

```sh
curl -X POST http://localhost:9090/redeploy-non-active
```

### POST /swap

Switch traffic 100% to non-active. Fails if non-active is not healthy.

```sh
curl -X POST http://localhost:9090/swap
```

Response:

```json
{ "ok": true, "active": "server1" }
```

... or failure if non-active is not healthy

```json
{ "ok": false, "reason": "swap is already in progress" }
```

## Deployment Flow

1. **Initial state**:
    Active (server1) live (`weight: 100`), Non-active (server2) idle (`weight: 0`).
2. **Redeploy non-active**:
    ```sh
    curl -X POST localhost:9090/redeploy-non-active
    ```
    Non-active (server2) is rebuilt, restarted, and warmed up.
3. **Verify non-active health**:
    ```sh
    curl localhost:9090/status
    # it will check localhost:4001/health
    ```
4. **Swap**:
    ```sh
    curl -X POST localhost:9090/swap
    ```
    Traefik flips weights: server2 = 100, server1 = 0.
    Now Active = server2, Non-active = server1.
5. **Rollback**: run `/swap` again after redeploying non-active (now server1).

## Logs

Inside the container:

* `/var/log/traefik.log` =\> Traefik logs
* `/var/log/manager.log` =\> Manager logs
* `/var/log/server1.log` =\> Output from server1 app
* `/var/log/server2.log` =\> Output from server2 app

## Security

* The **manage port (9090)** controls deployments.
  * Restrict it (bind to `127.0.0.1`, firewall, or VPN).
