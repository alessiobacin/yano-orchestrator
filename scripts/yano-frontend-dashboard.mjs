#!/usr/bin/env node

// Development-only project runner and reverse proxy. The public URL keeps the
// project id in the path, so browser/Agentation feedback cannot cross projects.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { globalDataPath } from "./yano-config.mjs";
import { inferFrontendDev } from "./yano-frontend-review.mjs";

const DASH_MIN = 10000,
  DASH_MAX = 10999,
  DEFAULT_DASH = 10000;
const stateFile = (id) =>
  path.join(
    globalDataPath({ env: process.env }),
    "frontend-dash",
    `${id}.json`,
  );
const val = (args, flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] || fallback : fallback;
};
function waitPort(port, timeout = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const probe = () => {
      const s = net.connect({ host: "127.0.0.1", port });
      const done = (ok) => {
        s.destroy();
        if (ok || Date.now() - start > timeout) resolve(ok);
        else setTimeout(probe, 250);
      };
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
      s.setTimeout(500, () => done(false));
    };
    probe();
  });
}
function freePort(server, requested = null) {
  return new Promise((resolve, reject) => {
    const candidates = requested
      ? [requested]
      : [
          DEFAULT_DASH,
          ...Array.from(
            { length: DASH_MAX - DASH_MIN + 1 },
            (_, i) => DASH_MIN + i,
          ).filter((p) => p !== DEFAULT_DASH),
        ];
    let i = 0;
    const next = () => {
      const fail = (e) => {
        server.removeListener("error", fail);
        if (e.code === "EADDRINUSE" && i < candidates.length) return next();
        reject(e);
      };
      server.once("error", fail);
      server.listen(candidates[i++], "127.0.0.1", () => {
        server.removeListener("error", fail);
        resolve(server.address().port);
      });
    };
    next();
  });
}
function saveState(id, state) {
  const file = stateFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    `${file}.tmp-${process.pid}`,
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(`${file}.tmp-${process.pid}`, file);
}
function loadState(id) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
  } catch {
    return null;
  }
}
function injectAgentation(root) {
  const info = inferFrontendDev(root);
  if (info.framework !== "react")
    return {
      supported: false,
      reason: "Agentation richiede un frontend React",
    };
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const installed = Boolean(
    { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }.agentation,
  );
  if (!installed) {
    const command = info.manager;
    const args =
      info.manager === "npm"
        ? ["install", "-D", "agentation"]
        : info.manager === "pnpm"
          ? ["add", "-D", "agentation"]
          : info.manager === "yarn"
            ? ["add", "-D", "agentation"]
            : ["add", "-d", "agentation"];
    const result = spawnSync(command, args, {
      cwd: root,
      stdio: "inherit",
      timeout: 120000,
    });
    if (result.status !== 0)
      return {
        supported: true,
        injected: false,
        reason: "installazione Agentation fallita",
      };
  }
  const dirs = ["src", "app", "pages"].map((d) => path.join(root, d));
  let entry = null;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^(main|index|_app|layout)\.(jsx?|tsx?)$/.test(f));
    if (files.length) {
      entry = path.join(dir, files[0]);
      break;
    }
  }
  if (!entry)
    return {
      supported: true,
      injected: false,
      reason: "entry React non individuato",
    };
  let source = fs.readFileSync(entry, "utf8");
  if (/from\s+["']agentation["']/.test(source))
    return { supported: true, injected: false, entry, already_present: true };
  const importLine = `\nimport { Agentation } from "agentation";\n`;
  let changed = false;
  if (/\.render\(\s*<([A-Za-z_$][\w$]*)\s*\/?>(?:\s*)\)/s.test(source))
    ((source = source.replace(
      /\.render\(\s*<([A-Za-z_$][\w$]*)\s*\/?>\s*\)/s,
      `.render(<><$1 />{(import.meta.env?.DEV ?? process.env.NODE_ENV === "development") && <Agentation endpoint="http://localhost:4747" />}</>)`,
    )),
      (changed = true));
  else if (/return\s*\(/.test(source))
    ((source = source.replace(
      /return\s*\(/,
      `return (\n{(typeof process === "undefined" || process.env.NODE_ENV === "development") && <Agentation endpoint="http://localhost:4747" />} `,
    )),
      (changed = true));
  if (!changed)
    return {
      supported: true,
      injected: false,
      entry,
      reason: "entry non modificato automaticamente; serve mount manuale",
    };
  source = importLine + source;
  fs.writeFileSync(entry, source);
  return { supported: true, injected: true, entry };
}
function proxy(server, projectId, targetPort, req, res) {
  const prefix = `/${encodeURIComponent(projectId)}`;
  const targetPath = req.url.startsWith(prefix)
    ? req.url.slice(prefix.length) || "/"
    : req.url;
  const request = http.request(
    {
      host: "127.0.0.1",
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
    },
    (upstream) => {
      const headers = { ...upstream.headers };
      const chunks = [];
      upstream.on("data", (c) => chunks.push(c));
      upstream.on("end", () => {
        let result = Buffer.concat(chunks);
        if (String(headers["content-type"] || "").includes("text/html")) {
          const text = result
            .toString("utf8")
            .replace(
              /<head>/i,
              `<head><base href="${prefix}/"><meta name="yano-project-id" content="${projectId}">`,
            );
          result = Buffer.from(text);
          headers["content-length"] = result.length;
          delete headers["content-encoding"];
        }
        res.writeHead(upstream.statusCode || 502, headers);
        res.end(result);
      });
    },
  );
  request.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`frontend non raggiungibile: ${e.message}`);
    }
  });
  req.pipe(request);
}
export async function runFrontendDashboard({ argv = [] } = {}) {
  const sub = argv[0] || "start";
  const projectPath = path.resolve(val(argv, "--project-path", process.cwd()));
  const projectId = val(
    argv,
    "--project-id",
    path
      .basename(projectPath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-"),
  );
  if (sub === "stop") {
    const state = loadState(projectId);
    if (state?.pid) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    }
    console.log(
      JSON.stringify(
        { stopped: Boolean(state), project_id: projectId },
        null,
        2,
      ),
    );
    return;
  }
  if (sub === "list") {
    const dir = path.dirname(stateFile("x"));
    console.log(
      JSON.stringify(
        fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((x) => x.endsWith(".json"))
              .map((x) =>
                JSON.parse(fs.readFileSync(path.join(dir, x), "utf8")),
              )
          : [],
        null,
        2,
      ),
    );
    return;
  }
  if (sub !== "start")
    throw new Error("Uso: yano frontend-dash start|stop|list");
  const info = inferFrontendDev(projectPath);
  const command =
    val(argv, "--command") ||
    val(argv, "--frontend-command") ||
    `${info.manager} run ${info.script}`;
  const targetPort = Number(val(argv, "--target-port", info.port));
  const backendCommand = val(argv, "--backend-command");
  const backendPort = val(argv, "--backend-port") ? Number(val(argv, "--backend-port")) : null;
  const injected = injectAgentation(projectPath);
  const backend = backendCommand
    ? spawn(backendCommand, {
        cwd: projectPath,
        shell: true,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: "development", PORT: String(backendPort || ""), YANO_PROJECT_ID: projectId },
      })
    : null;
  const child = spawn(command, {
    cwd: projectPath,
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(targetPort),
      YANO_PROJECT_ID: projectId,
    },
  });
  const reachable = await waitPort(targetPort);
  if (!reachable) {
    child.kill("SIGTERM");
    backend?.kill("SIGTERM");
    throw new Error(
      `frontend non raggiungibile su ${targetPort}; comando: ${command}`,
    );
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/healthz")
      return res.end(
        JSON.stringify({
          ok: true,
          project_id: projectId,
          target_port: targetPort,
        }),
      );
    if (url.pathname === "/" || url.pathname.startsWith(`/${projectId}`))
      return proxy(server, projectId, targetPort, req, res);
    res.writeHead(302, { location: `/${projectId}/` });
    res.end();
  });
  const port = await freePort(
    server,
    val(argv, "--port") ? Number(val(argv, "--port")) : null,
  );
  const state = {
    project_id: projectId,
    project_path: projectPath,
    pid: process.pid,
    child_pid: child.pid,
    backend_pid: backend?.pid || null,
    dashboard_port: port,
    target_port: targetPort,
    url: `http://127.0.0.1:${port}/${projectId}/`,
    command,
    backend_command: backendCommand || null,
    backend_port: backendPort,
    agentation: injected,
    started_at: new Date().toISOString(),
  };
  saveState(projectId, state);
  console.log(`yano frontend-dash: ${state.url}`);
  console.log(
    `Agentation: ${injected.injected || injected.already_present ? "attivo in development" : `non montato (${injected.reason || "non supportato"})`}`,
  );
  const shutdown = () => {
    try {
      child.kill("SIGTERM");
    } catch {}
    try {
      backend?.kill("SIGTERM");
    } catch {}
    server.close();
    saveState(projectId, {
      ...state,
      pid: null,
      stopped_at: new Date().toISOString(),
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  child.once("exit", (code) => {
    saveState(projectId, {
      ...state,
      pid: null,
      child_pid: null,
      backend_pid: backend?.pid || null,
      exited_at: new Date().toISOString(),
      exit_code: code,
    });
    server.close();
  });
  backend?.once("exit", (code) => {
    saveState(projectId, { ...state, pid: null, backend_pid: null, backend_exit_code: code, exited_at: new Date().toISOString() });
    try { child.kill("SIGTERM"); } catch {}
    server.close();
  });
}
