# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- `npm run dev` - Run in development mode without compilation
- `npm run build` - Compile TypeScript to JavaScript (outputs to `dist/`)
- `npm start` - Run the compiled application from `dist/index.js`

### Testing
From the repository root:
```bash
(cd test/snapshot && npm i)
sh test/test.sh
# or with sudo if Docker operations require it:
# sudo --preserve-env=PATH sh test/test.sh
```

## Architecture

This is a **blue-green deployment manager** that orchestrates zero-downtime deployments using Traefik as a reverse proxy. The system manages two identical application instances (`server1` and `server2`) and switches traffic between them.

### Core Components

1. **Manager API** (`src/index.ts`)
   - Express.js server on port 9090 (configurable via `MANAGE_PORT`)
   - Manages deployment lifecycle and traffic switching
   - Spawns and monitors child processes for Traefik and both app servers

2. **Traefik Configuration**
   - `config/traefik.yml` - Static configuration with entrypoints
   - `config/slots.yml` - Dynamic configuration with weighted routing (auto-generated)
   - Watches `slots.yml` for hot-reload of traffic weights

3. **Application Slots**
   - `server1` - Runs on localhost:4000, managed at localhost:3000
   - `server2` - Runs on localhost:4001, managed at localhost:3001
   - Only one is "active" (receives production traffic) at a time

### Traffic Flow
- **Port 8080**: Active production traffic via Traefik
- **Port 8081**: Non-active server for testing
- **Port 9090**: Management API for deployments

### Key State Management
- `active` variable tracks which slot is receiving production traffic
- `swapping` flag prevents concurrent swap operations
- `writeWeights()` function generates Traefik configuration with proper routing weights

### Process Management
- Uses `spawn()` with proper signal handling for graceful shutdowns
- Implements `gracefulShutdown()` with SIGTERM followed by SIGKILL
- Process groups (`detached: true`) for proper child process cleanup
- All processes are tracked in `procs` object for lifecycle management

### Health Checking
- `checkHealth()` function calls `/health` endpoint on each server
- Health checks prevent swaps to unhealthy servers
- Separate log streams for each server with active/non-active prefixes

### Webhook System
The manager supports server notification webhooks via `SERVER1_MANAGE_URL` and `SERVER2_MANAGE_URL`:
- `POST /prepare-to-be-active` - Notifies server it will become active
- `POST /prepare-to-be-non-active` - Notifies server it will become non-active
- `POST /activated` - Confirms server is now active
- `POST /deactivated` - Confirms server is now non-active
- `POST /cancel-prepare-*` - Cancels swap if preparation fails

### Deployment Workflow
1. **Redeploy non-active**: Kill process → git pull → npm ci → npm run build → npm test → npm start
2. **Swap**: Health check non-active → Update weights → Notify servers
3. **Rollback**: Repeat process with roles reversed

## File Structure

- `src/index.ts` - Single-file application containing all logic
- `config/traefik.yml` - Static Traefik configuration
- `config/slots.yml` - Dynamic routing weights (auto-generated)
- `package.json` - Standard Node.js project with TypeScript setup
- `tsconfig.json` - TypeScript configuration targeting ES2020/CommonJS

## Environment Variables

- `MANAGE_PORT` - Management API port (default: 9090)
- `SERVER1_MANAGE_URL` - Webhook URL for server1 (default: http://localhost:4000/server-manager)
- `SERVER2_MANAGE_URL` - Webhook URL for server2 (default: http://localhost:4001/server-manager)

## Logging

All logs are written to `/var/log/` in container:
- `manager.log` - Management operations and errors
- `traefik.log` - Traefik proxy logs
- `server1.log` - Server1 stdout/stderr with active/non-active prefixes
- `server2.log` - Server2 stdout/stderr with active/non-active prefixes
