import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { connectViaProxy, selectProxyUrl } from "./quota";

describe("selectProxyUrl", () => {
  it("prefers HTTPS_PROXY then falls back through the env chain", () => {
    expect(selectProxyUrl({ HTTPS_PROXY: "http://a:1" })).toBe("http://a:1");
    expect(selectProxyUrl({ https_proxy: "http://b:2" })).toBe("http://b:2");
    expect(selectProxyUrl({ HTTP_PROXY: "http://c:3" })).toBe("http://c:3");
    expect(selectProxyUrl({ http_proxy: "http://d:4" })).toBe("http://d:4");
    expect(selectProxyUrl({ ALL_PROXY: "http://e:5" })).toBe("http://e:5");
  });

  it("ignores socks proxies that CONNECT tunneling cannot use", () => {
    expect(selectProxyUrl({ ALL_PROXY: "socks5://127.0.0.1:7897" })).toBeUndefined();
    expect(selectProxyUrl({ https_proxy: "socks5://x:1", HTTPS_PROXY: "http://ok:2" })).toBe("http://ok:2");
  });

  it("returns undefined when no proxy is set", () => {
    expect(selectProxyUrl({})).toBeUndefined();
  });
});

describe("connectViaProxy", () => {
  it("tunnels through an HTTP CONNECT proxy to the target", async () => {
    const target = net.createServer((socket) => socket.end("HELLO\n"));
    await listen(target);
    const targetPort = addressPort(target);

    const proxy = http.createServer();
    proxy.on("connect", (req, clientSocket, head) => {
      const [host, port] = (req.url ?? "").split(":");
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    await listen(proxy);
    const proxyPort = addressPort(proxy);

    try {
      const socket = await connectViaProxy(`http://127.0.0.1:${proxyPort}`, "127.0.0.1", targetPort, 2000);
      expect(await readAll(socket)).toContain("HELLO");
    } finally {
      proxy.close();
      target.close();
    }
  });

  it("rejects when the proxy refuses the CONNECT", async () => {
    const proxy = http.createServer();
    proxy.on("connect", (_req, clientSocket) => {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
    });
    await listen(proxy);
    const proxyPort = addressPort(proxy);

    try {
      await expect(connectViaProxy(`http://127.0.0.1:${proxyPort}`, "127.0.0.1", 9, 2000)).rejects.toThrow(/403/);
    } finally {
      proxy.close();
    }
  });
});

function listen(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

function addressPort(server: net.Server | http.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function readAll(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}
