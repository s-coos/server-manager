import express from "express";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import readline from "readline";

const app = express();
const managePort = Number(process.env.MANAGE_PORT) || 9090;
const workdir = "/workdir";
const traefikBin = "traefik";
const logDir = "/var/log";
const managerLog = fs.createWriteStream(path.join(logDir, "manager.log"), {
  flags: "a",
});

function log(line: string) {
  const msg = `${new Date().toISOString()} ${line}
`;
  managerLog.write(msg);
  console.log(line);
}

const configDir = path.join(__dirname, "../config");
const traefikConfig = path.join(configDir, "traefik.yml");
const slotsConfig = path.join(configDir, "slots.yml");

type Slot = "server1" | "server2";
let active: Slot = "server1";
let swapping = false;

function nonActive(): Slot {
  return active === "server1" ? "server2" : "server1";
}

function spawnTraefik(): ChildProcess {
  const proc = spawn(traefikBin, ["--configFile", traefikConfig], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tlog = fs.createWriteStream(path.join(logDir, "traefik.log"), {
    flags: "a",
  });
  proc.stdout?.on("data", (d) => tlog.write(d));
  proc.stderr?.on("data", (d) => tlog.write(d));
  return proc;
}

const serverLogs: Record<Slot, fs.WriteStream> = {
  server1: fs.createWriteStream(path.join(logDir, "server1.log"), {
    flags: "a",
  }),
  server2: fs.createWriteStream(path.join(logDir, "server2.log"), {
    flags: "a",
  }),
};

function attachServerLogs(slot: Slot, proc: ChildProcess) {
  const logStream = serverLogs[slot];
  const handle = (line: string) => {
    const prefix = slot === active ? "    active: " : "non-active: ";
    logStream.write(`${prefix}${line}
`);
  };
  if (proc.stdout) {
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", handle);
  }
  if (proc.stderr) {
    const rl = readline.createInterface({ input: proc.stderr });
    rl.on("line", handle);
  }
}

function spawnServer(slot: Slot): ChildProcess {
  const cwd = path.join(workdir, slot);
  const proc = spawn("npm", ["start"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachServerLogs(slot, proc);
  return proc;
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`run: ${cmd} ${args.join(" ")} in ${cwd}`);
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const handler = (d: Buffer) => managerLog.write(d);
    p.stdout?.on("data", handler);
    p.stderr?.on("data", handler);
    p.on("exit", (code) => {
      if (code === 0) {
        log(`${cmd} succeeded`);
        resolve();
      } else {
        log(`${cmd} failed with code ${code}`);
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
    p.on("error", (err) => {
      log(`${cmd} error: ${err.message}`);
      reject(err);
    });
  });
}

function checkHealth(slot: Slot): Promise<boolean> {
  const port = slot === "server1" ? 4000 : 4001;
  return new Promise((resolve) => {
    http
      .get(`http://localhost:${port}/health`, (res) => {
        resolve(res.statusCode === 200);
      })
      .on("error", () => resolve(false));
  });
}

function writeWeights() {
  const content = `http:
  routers:
    web:
      entryPoints:
        - web
      service: s-main
    test:
      entryPoints:
        - web2
      service: s-server2
  services:
    s-main:
      weighted:
        services:
          - name: s-server1
            weight: ${active === "server1" ? 1 : 0}
          - name: s-server2
            weight: ${active === "server2" ? 1 : 0}
    s-server1:
      loadBalancer:
        servers:
          - url: "http://localhost:4000"
    s-server2:
      loadBalancer:
        servers:
          - url: "http://localhost:4001"
`;
  fs.writeFileSync(slotsConfig, content);
  log(`weights updated: active=${active}`);
}

const procs: Record<string, ChildProcess> = {
  traefik: spawnTraefik(),
  server1: spawnServer("server1"),
  server2: spawnServer("server2"),
};

writeWeights();

app.get("/status", async (_req, res) => {
  const [h1, h2] = await Promise.all([
    checkHealth("server1"),
    checkHealth("server2"),
  ]);
  res.json({
    server1: h1,
    server2: h2,
    active,
    "non-active": nonActive(),
  });
});

app.post("/swap", async (_req, res) => {
  if (swapping) {
    log("swap rejected: already in progress");
    return res.json({ ok: false, reason: "swap is already in progress" });
  }
  swapping = true;
  const target = nonActive();
  if (!(await checkHealth(target))) {
    swapping = false;
    log("swap aborted: non-active not healthy");
    return res.json({ ok: false, reason: "non-active is not healthy" });
  }
  active = target;
  writeWeights();
  swapping = false;
  log(`swap complete: active=${active}`);
  res.json({ ok: true, active });
});

app.post("/redeploy-non-active", async (_req, res) => {
  const target = nonActive();
  const cwd = path.join(workdir, target);
  try {
    log(`redeploying ${target}`);
    procs[target].kill();
    await runCommand("git", ["pull"], cwd);
    await runCommand("npm", ["install"], cwd);
    await runCommand("npm", ["run", "build"], cwd);
    await runCommand("npm", ["test"], cwd);
    procs[target] = spawnServer(target);
    log(`redeploy complete for ${target}`);
    res.json({ ok: true, redeployed: target });
  } catch (err: any) {
    log(`redeploy failed for ${target}: ${err.message}`);
    res.json({ ok: false, reason: err.message });
  }
});

app.listen(managePort, () => {
  log(`manager listening on ${managePort}`);
});

function shutdown() {
  log("shutting down");
  Object.values(procs).forEach((p) => p.kill());
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
