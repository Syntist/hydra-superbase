const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const WebSocket = require("ws");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fatalPattern =
  /A JavaScript error occurred in the main process|Uncaught Exception|Uncaught Error|Cannot read properties of undefined|UnhandledPromiseRejection/;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function inspectPage(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Renderer inspection timed out")),
        3000
      );
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: `({ title: document.title, url: location.href,
            rendered: Boolean(document.querySelector('#root')?.childElementCount),
            textLength: document.body.innerText.trim().length,
            preload: typeof window.electron === 'object' })`,
            returnByValue: true,
          },
        })
      );
    });
    return response.result?.value;
  } finally {
    socket.close();
  }
}

async function main() {
  const executable = process.argv[2];
  if (!executable)
    throw new Error(
      "Usage: node scripts/smoke-linux-startup.cjs /path/to/Hydra.AppImage"
    );
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-startup-"));
  const port = await availablePort();
  let output = "";
  let spawnError;
  const child = spawn(
    path.resolve(executable),
    [
      // The isolated build container has no Chromium sandbox helper configured.
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${port}`,
    ],
    {
      detached: true,
      env: {
        ...process.env,
        HOME: temporary,
        XDG_CONFIG_HOME: path.join(temporary, "config"),
        XDG_CACHE_HOME: path.join(temporary, "cache"),
        XDG_DATA_HOME: path.join(temporary, "data"),
        APPIMAGE_EXTRACT_AND_RUN: "1",
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.once("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output = (output + data.toString()).slice(-100_000);
    });
  }
  let result;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (fatalPattern.test(output))
        throw new Error(
          "Packaged application reported an uncaught startup error"
        );
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Packaged application exited during startup (${child.exitCode ?? child.signalCode})`
        );
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1500),
        });
        const pages = await response.json();
        for (const page of pages.filter(
          (item) => item.type === "page" && item.url.startsWith("file://")
        )) {
          const state = await inspectPage(page.webSocketDebuggerUrl);
          if (state?.rendered && state.preload && state.textLength > 30)
            result = state;
        }
      } catch {
        /* The renderer/debugger may not be ready yet. */
      }
      if (result) {
        await delay(3000);
        if (fatalPattern.test(output))
          throw new Error(
            "Packaged application reported a delayed uncaught startup error"
          );
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Packaged application exited after rendering");
        console.log(
          "Packaged AppImage startup passed:",
          JSON.stringify(result)
        );
        return;
      }
      await delay(300);
    }
    throw new Error(
      "Packaged application did not render its local UI and preload bridge within 60 seconds"
    );
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
      await delay(500);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
