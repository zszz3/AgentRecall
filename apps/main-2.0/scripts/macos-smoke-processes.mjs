import { setTimeout as delay } from "node:timers/promises";

function signalOwnedGroup(pid, signal) {
  // Only accept the PID returned by our detached spawn, never a broad name match.
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error("Invalid owned smoke process group");
  }
  try { process.kill(-pid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export async function waitForSmokeProcessGroupExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let probeError;
    try {
      if (!signalOwnedGroup(pid, 0)) return true;
    } catch (error) {
      // macOS can return EPERM for a group containing only unreaped zombies.
      // Retry the probe, but only ESRCH confirms exit; signal errors still fail.
      if (error.code !== "EPERM") throw error;
      probeError = error;
    }
    if (Date.now() >= deadline) {
      if (probeError) throw probeError;
      return false;
    }
    await delay(Math.min(50, deadline - Date.now()));
  }
}

// Failure recovery only: ordinary smoke success must first prove natural exit.
// Wait for the group, not the parent: an exited leader may leave live helpers.
export async function cleanupSmokeProcessGroup(pid, timeoutMs = 3000) {
  const signals = [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!signalOwnedGroup(pid, signal)) return { confirmed: true, signals };
    signals.push(signal);
    if (await waitForSmokeProcessGroupExit(pid, timeoutMs)) return { confirmed: true, signals };
  }
  throw new Error(`Owned smoke process group ${pid} did not exit; fixtures retained`);
}
