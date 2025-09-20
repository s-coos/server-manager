import express from "express";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import readline from "readline";

const app = express();
const managePort = Number(process.env.MANAGE_PORT) || 9090;
const server1ManageUrl =
  process.env.SERVER1_MANAGE_URL || "http://localhost:4000/server-manager";
const server2ManageUrl =
  process.env.SERVER2_MANAGE_URL || "http://localhost:4001/server-manager";
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
    logStream.write(`${prefix}${line}\n`);
  };
  if (proc.stdout) {
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => handle(`stdout: ${line}`));
  }
  if (proc.stderr) {
    const rl = readline.createInterface({ input: proc.stderr });
    rl.on("line", (line) => handle(`stderr: ${line}`));
  }
}

function spawnServer(slot: Slot): ChildProcess {
  const cwd = path.join(workdir, slot);
  const proc = spawn("npm", ["start"], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachServerLogs(slot, proc);
  return proc;
}

function waitForExit(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    proc.once("exit", finish).once("close", finish);
    setTimeout(finish, timeoutMs);
  });
}

function signalGroup(proc: ChildProcess, sig: NodeJS.Signals = "SIGTERM") {
  if (proc?.pid && proc.pid > 0) {
    try {
      process.kill(-proc.pid, sig);
    } catch {}
  }
}

async function gracefulShutdown(proc: ChildProcess, graceMs = 5000) {
  if (proc.killed) return;
  signalGroup(proc, "SIGTERM");
  await waitForExit(proc, graceMs);
  if (proc.exitCode === null && proc.signalCode === null) {
    signalGroup(proc, "SIGKILL");
    await waitForExit(proc, 1000);
  }
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`run: ${cmd}${args.map((a) => ` ${a}`).join("")} in ${cwd}`);
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const handler = (d: Buffer) => managerLog.write(d);
    p.stdout?.on("data", handler);
    p.stderr?.on("data", handler);
    p.on("exit", (code) => {
      if (code === 0) {
        log(`${cmd} succeeded`);
        resolve();
      } else {
        reject(
          new Error(
            `${cmd}${args
              .map((a) => ` ${a}`)
              .join("")} exited with code ${code}`
          )
        );
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

function callWebhook(url: string, timeout = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(url, { method: "POST", timeout }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function prepareSwap(
  targetSlot: Slot
): Promise<{ success: boolean; reason?: string }> {
  const targetUrl =
    targetSlot === "server1" ? server1ManageUrl : server2ManageUrl;
  const currentUrl =
    targetSlot === "server1" ? server2ManageUrl : server1ManageUrl;

  log(`preparing swap: ${targetSlot} -> active`);

  const [prepareActiveResult, prepareNonActiveResult] = await Promise.all([
    callWebhook(`${targetUrl}/prepare-to-be-active`),
    callWebhook(`${currentUrl}/prepare-to-be-non-active`),
  ]);

  if (!prepareActiveResult && !prepareNonActiveResult) {
    log("swap cancelled: both prepare webhooks failed");
    return { success: false, reason: "both servers rejected preparation" };
  }

  if (!prepareActiveResult) {
    log("swap cancelled: prepare-to-be-active failed");
    if (prepareNonActiveResult) {
      await callWebhook(`${currentUrl}/cancel-prepare-to-be-non-active`);
    }
    return { success: false, reason: "target server rejected preparation" };
  }

  if (!prepareNonActiveResult) {
    log("swap cancelled: prepare-to-be-non-active failed");
    await callWebhook(`${targetUrl}/cancel-prepare-to-be-active`);
    return {
      success: false,
      reason: "current active server rejected preparation",
    };
  }

  return { success: true };
}

async function completeSwap(targetSlot: Slot): Promise<void> {
  const targetUrl =
    targetSlot === "server1" ? server1ManageUrl : server2ManageUrl;
  const currentUrl =
    targetSlot === "server1" ? server2ManageUrl : server1ManageUrl;

  log(`completing swap: ${targetSlot} is now active`);

  await Promise.all([
    callWebhook(`${targetUrl}/activated`),
    callWebhook(`${currentUrl}/deactivated`),
  ]);
}

function writeWeights() {
  const content = `http:
  routers:
    web:
      entryPoints:
        - web
      rule: "PathPrefix(\`/\`)"
      service: s-active
    test:
      entryPoints:
        - web2
      rule: "PathPrefix(\`/\`)"
      service: s-non-active
  services:
    s-active:
      weighted:
        services:
          - name: s-server1
            weight: ${active === "server1" ? 1 : 0}
          - name: s-server2
            weight: ${active === "server2" ? 1 : 0}
    s-non-active:
      weighted:
        services:
          - name: s-server1
            weight: ${active === "server1" ? 0 : 1}
          - name: s-server2
            weight: ${active === "server2" ? 0 : 1}
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
  try {
    const target = nonActive();
    if (!(await checkHealth(target))) {
      log("swap aborted: non-active not healthy");
      return res.json({ ok: false, reason: "non-active is not healthy" });
    }

    const prepareResult = await prepareSwap(target);
    if (!prepareResult.success) {
      log(`swap aborted: ${prepareResult.reason}`);
      return res.json({ ok: false, reason: prepareResult.reason });
    }

    active = target;
    writeWeights();

    await completeSwap(target);

    log(`swap complete: active=${active}`);
    res.json({ ok: true, active });
  } catch (err: any) {
    log(`swap error: ${err.message}`);
    res.json({ ok: false, reason: "server error" });
  } finally {
    swapping = false;
  }
});

app.post("/redeploy-non-active", async (_req, res) => {
  const target = nonActive();
  const cwd = path.join(workdir, target);
  try {
    log(`redeploying ${target}`);
    const old = procs[target];
    if (!old.killed) {
      await gracefulShutdown(old, 5000);
    }
    await runCommand("git", ["pull"], cwd);
    await runCommand("npm", ["ci"], cwd);
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
