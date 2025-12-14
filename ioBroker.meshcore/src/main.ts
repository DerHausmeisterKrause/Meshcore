import * as utils from "@iobroker/adapter-core";
import { TCPConnection } from "@liamcottle/meshcore.js";

type RpcRequest = {
  method: string;
  args?: unknown[];
};

type RpcResponseOk = { ok: true; result: unknown };
type RpcResponseErr = { ok: false; error: string };
type RpcResponse = RpcResponseOk | RpcResponseErr;

class MeshcoreAdapter extends utils.Adapter {
  private conn: any | null = null;
  private reconnectTimer: ioBroker.Timeout | null = null;
  private contactsTimer: ioBroker.Timeout | null = null;
  private isShuttingDown = false;

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "meshcore" });

    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }

  private async onReady(): Promise<void> {
    const host = String(this.config.host || "").trim();
    const port = Number(this.config.port || 0);
    const reconnectMs = this.toPositiveInt(this.config.reconnectMs, 5000);
    const refreshContactsMs = this.toPositiveInt(this.config.refreshContactsMs, 60000);

    await this.ensureObjects();

    await this.setStateAsync("info.host", host, true);
    await this.setStateAsync("info.port", port, true);
    await this.setStateAsync("info.connection", false, true);
    await this.setStateAsync("info.lastError", "", true);

    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      await this.setStateAsync("info.lastError", "Config invalid: host/port", true);
      this.log.error("Config invalid: host/port");
      return;
    }

    await this.connect(host, port, reconnectMs, refreshContactsMs);
  }

  private toPositiveInt(value: unknown, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  }

  private async ensureObjects(): Promise<void> {
    const mkState = async (id: string, common: ioBroker.StateCommon) => {
      await this.setObjectNotExistsAsync(id, { type: "state", common, native: {} });
    };

    await mkState("info.connection", {
      name: "Connected",
      type: "boolean",
      role: "indicator.connected",
      read: true,
      write: false,
      def: false,
    });

    await mkState("info.lastError", {
      name: "Last error",
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: "",
    });

    await mkState("info.host", {
      name: "Host",
      type: "string",
      role: "info.address",
      read: true,
      write: false,
      def: "",
    });

    await mkState("info.port", {
      name: "Port",
      type: "number",
      role: "info.port",
      read: true,
      write: false,
      def: 0,
    });

    await mkState("contacts.json", {
      name: "Contacts JSON",
      type: "string",
      role: "json",
      read: true,
      write: false,
      def: "[]",
    });

    await mkState("rpc.lastCall", {
      name: "RPC last call",
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: "",
    });

    await mkState("rpc.lastResultJson", {
      name: "RPC last result JSON",
      type: "string",
      role: "json",
      read: true,
      write: false,
      def: "",
    });

    await mkState("rpc.lastError", {
      name: "RPC last error",
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: "",
    });
  }

  private async connect(host: string, port: number, reconnectMs: number, refreshContactsMs: number): Promise<void> {
    if (this.isShuttingDown) return;

    this.log.info(`Connecting to MeshCore Companion TCP at ${host}:${port}`);

    try {
      await this.cleanupConnection();

      const conn = new TCPConnection(host, port);
      this.conn = conn;

      conn.on("connected", async () => {
        if (this.isShuttingDown) return;

        this.log.info("MeshCore connected");
        await this.setStateAsync("info.connection", true, true);
        await this.setStateAsync("info.lastError", "", true);

        await this.refreshContactsSafe();
        this.startContactsTimer(refreshContactsMs);
      });

      conn.on("disconnected", async () => {
        if (this.isShuttingDown) return;

        this.log.warn("MeshCore disconnected");
        await this.setStateAsync("info.connection", false, true);
        this.stopContactsTimer();

        this.scheduleReconnect(host, port, reconnectMs, refreshContactsMs);
      });

      await conn.connect();
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      this.log.error(`Connect failed: ${msg}`);
      await this.setStateAsync("info.connection", false, true);
      await this.setStateAsync("info.lastError", msg, true);

      this.scheduleReconnect(host, port, reconnectMs, refreshContactsMs);
    }
  }

  private scheduleReconnect(host: string, port: number, reconnectMs: number, refreshContactsMs: number): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = this.setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect(host, port, reconnectMs, refreshContactsMs);
    }, reconnectMs);
  }

  private startContactsTimer(refreshContactsMs: number): void {
    this.stopContactsTimer();
    this.contactsTimer = this.setInterval(async () => {
      await this.refreshContactsSafe();
    }, refreshContactsMs);
  }

  private stopContactsTimer(): void {
    if (this.contactsTimer) this.clearInterval(this.contactsTimer);
    this.contactsTimer = null;
  }

  private async refreshContactsSafe(): Promise<void> {
    try {
      if (!this.conn) return;
      if (typeof this.conn.getContacts !== "function") return;

      const contacts = await this.conn.getContacts();
      await this.setStateAsync("contacts.json", JSON.stringify(contacts ?? []), true);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      this.log.warn(`getContacts failed: ${msg}`);
    }
  }

  private async cleanupConnection(): Promise<void> {
    this.stopContactsTimer();

    if (this.reconnectTimer) this.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    try {
      if (this.conn && typeof this.conn.close === "function") {
        this.conn.close();
      }
    } catch {
    }

    this.conn = null;
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    if (!obj?.command) return;

    if (obj.command === "meshcore.rpc") {
      const res = await this.handleRpc(obj.message as RpcRequest);
      if (obj.callback) this.sendTo(obj.from, obj.command, res, obj.callback);
      return;
    }

    if (obj.command === "meshcore.getMethods") {
      const list = this.getPublicMethodNames();
      if (obj.callback) this.sendTo(obj.from, obj.command, { ok: true, methods: list }, obj.callback);
      return;
    }
  }

  private getPublicMethodNames(): string[] {
    const c = this.conn;
    if (!c) return [];
    const proto = Object.getPrototypeOf(c);
    const names = new Set<string>();

    const add = (o: any) => {
      if (!o) return;
      for (const k of Object.getOwnPropertyNames(o)) {
        if (k === "constructor") continue;
        if (k.startsWith("_")) continue;
        const v = c[k];
        if (typeof v === "function") names.add(k);
      }
    };

    add(proto);
    add(c);

    return Array.from(names).sort();
  }

  private async handleRpc(req: RpcRequest): Promise<RpcResponse> {
    const method = String(req?.method || "").trim();
    const args = Array.isArray(req?.args) ? req.args : [];

    await this.setStateAsync("rpc.lastCall", JSON.stringify({ method, args }), true);
    await this.setStateAsync("rpc.lastError", "", true);

    try {
      if (!this.conn) throw new Error("not connected");
      const fn = this.conn[method];
      if (typeof fn !== "function") throw new Error(`unknown method: ${method}`);

      const result = await fn.apply(this.conn, args);

      const json = JSON.stringify(result ?? null);
      await this.setStateAsync("rpc.lastResultJson", json, true);

      return { ok: true, result };
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      await this.setStateAsync("rpc.lastError", msg, true);
      return { ok: false, error: msg };
    }
  }

  private async onUnload(callback: () => void): Promise<void> {
    this.isShuttingDown = true;
    await this.cleanupConnection();
    callback();
  }
}

export default (options: Partial<utils.AdapterOptions> = {}) => new MeshcoreAdapter(options);
