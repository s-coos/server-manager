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

* **8080** =\> service (active, user traffic via Traefik)
* **8081** =\> non-active (for testing, ...)
* **9090** =\> manage API (deployment control)

## Features

* **Zero-downtime cutovers**: switch from active =\> non-active only after health checks pass.
* **In-place redeploy**: kill the old non-active process, `git pull`, `npm i`, `npm run build`, `npm test`, `npm start`.
* **Self-contained**: one container, base image = Node.js; Traefik binary is copied in at build.
* **Hot reload**: Traefik watches `slots.yml` and applies new weights instantly.

## Architecture

```
+---------------------------------+
|        Container                |
|                                 |
|  Traefik (service :8080)        | ← user traffic
|   └─ reverse_proxy => s-main    |
|      ├─ s-server1 => :4000      |
|      └─ s-server2 => :4001      |
|                                 |
|  Node.js manager (:9090)        | ← /redeploy-non-active,
|                                 |   /swap, /status
|  App 1 (npm start :4000, :3000) | ← /prepare-to-be-active,
|  App 2 (npm start :4001, :3001) |   /activated, etc.
+---------------------------------+
```

## Getting Started

### 1. Prepare App Workdirs

Prepare workdir with two git worktrees `server1`, `server2` including required configurations such as `.env`.

```sh
mkdir workdir

# possibly with --single-branch --branch <release-branch-name>
git -C workdir clone https://github.com/repo/path.git server1
git -C workdir clone https://github.com/repo/path.git server2

# prepare required configurations
printf "PORT=4000\nMANAGE_PORT=3000\n" > workdir/server1/.env
(cd workdir/server1 && npm i && npm run build)
printf "PORT=4001\nMANAGE_PORT=3001\n" > workdir/server2/.env
(cd workdir/server2 && npm i && npm run build)
cp .askpass.sh workdir # if needed
```

### 2. Build and Run

```sh
docker build -t server-manager .

docker run -d \
  -p 8080:8080 \                                # active service
  -p 127.0.0.1:8081:8081 \                      # non-active
  -p 127.0.0.1:9090:9090 \                      # manage API
  -v /abs/path/to/workdir:/workdir \            # workdir
  -e SERVER1_MANAGE_URL="http://localhost:3000" # defaults to \
  -e SERVER2_MANAGE_URL="http://localhost:3001" #  /server-manager
  # -e GIT_ASKPASS="..." \                      # if needed
  server-manager
```

Traefik will start serving traffic on `http://localhost:8080`.

## `docker-compose.yml` example

It's recommended to use `docker-compose.yml` to run the container.

```yaml
services:
  server-manager:
    image: server-manager
    ports:
      - 8080:8080
      - 127.0.0.1:8081:8081
      - 127.0.0.1:9090:9090
    volumes:
      - ./workdir:/workdir
    restart: unless-stopped
    # environment:
    #   - GIT_ASKPASS=...
```

## Management API

API for manage deployment by server manager

### GET `/status`

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

### POST `/redeploy-non-active`

Redeploy the non-active slot.

* Kills `npm start` process on non-active slot
* `git pull && npm i && npm run build && npm test && npm start` in `/workdir/server2`
* Check if `/health` passes
* Leaves weight at 0 (or 1 to enable health probing)

```sh
curl -X POST http://localhost:9090/redeploy-non-active
```

### POST `/swap`

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
    - Active (server1) live (`weight: 100`), Non-active (server2) idle (`weight: 0`).
    - After first successful health check on server1, server1 will receive now-active webhook.
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

## Swap webhook

API used by server manager to notify about swap for servers.

### GET `/health`

Check if the server is healthy.

To report that the server is healthy, you should return 200 status code.

### POST `${MANAGE_URL}/prepare-to-be-active`

Notify about swap for servers, that this server is going to be active.

To report that the server is healthy, you should return 200 status code.

### POST `${MANAGE_URL}/prepare-to-be-non-active`

Opposite of `prepare-to-be-active`, called concurently with it.

You can reject swap by returning non-200 status code.

Before returning 200, the server must stop all tasks that should not run concurrently but may be temporarily paused. (Use something other for tasks should not be stopped.)

### POST `${MANAGE_URL}/activated`

Notify about swap for servers, that this server is now active.

You can run jobs that should not run concurrently, after this call.

Requests still can be sent to other server because of traefik delay.

Status code is ignored.

### POST `${MANAGE_URL}/deactivated`

Opposite of `activated`, called concurently with it.

Requests still can be sent to this server because of traefik delay.

### POST `${MANAGE_URL}/cancel-prepare-to-be-active`

Notify that swap is cancelled.

Not called if prepare-to-be-active was not returned 200.

Status code is ignored.

### POST `${MANAGE_URL}/cancel-prepare-to-be-non-active`

Opposite of `cancel-prepare-to-be-active`.

## Swap Flow

Swap can be rejected by:

- `prepare-to-be-active` returned non-200
- `prepare-to-be-non-active` returned non-200

### Successful case

1. **Wait for `prepare-to-be-active` and `prepare-to-be-non-active`**
    - `${SERVER1_MANAGE_URL}/prepare-to-be-active` - 200 OK
    - `${SERVER2_MANAGE_URL}/prepare-to-be-non-active` - 200 OK
2. **Call `activated` and `deactivated`**
    - `${SERVER1_MANAGE_URL}/activated`
    - `${SERVER2_MANAGE_URL}/deactivated`

### Rejected case

1. **Wait for `prepare-to-be-active` and `prepare-to-be-non-active`**
    - Some of them returned non-200
2. **Call `cancel-prepare-to-be-active`, `cancel-prepare-to-be-non-active`**
    - If both returned non-200, nothing will happen.
    - If one returned non-200, the other will be called.

## Logs

Inside the container:

* `/var/log/traefik.log` =\> Traefik logs
* `/var/log/manager.log` =\> Manager logs
* `/var/log/server1.log` =\> Output from server1 app
* `/var/log/server2.log` =\> Output from server2 app

Each line in `server1.log` and `server2.log` is prefixed with either `active:` or `non-active:`
to indicate the slot's role when the line was written.

## Security

* The **manage port (9090)** controls deployments.
  * Restrict it (bind to `127.0.0.1`, firewall, or VPN).

## Development

### Testing

`package-lock.json` for testing is not included in the repo.

```sh
(cd test/snapshot && npm i)
sh test/test.sh # ... or add sudo if required as docker operations are performed
# sudo --preserve-env=PATH sh test/test.sh
```
