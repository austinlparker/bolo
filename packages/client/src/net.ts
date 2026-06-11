import type { ClientMsg, ServerMsg } from '@bolo/shared';

export type MsgHandler = (msg: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handler: MsgHandler;
  private wantReconnect = true;
  private hello: () => ClientMsg;

  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(handler: MsgHandler, hello: () => ClientMsg) {
    this.handler = handler;
    this.hello = hello;
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify(this.hello()));
      this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      try {
        this.handler(JSON.parse(ev.data as string) as ServerMsg);
      } catch (err) {
        console.error('bad server message', err);
      }
    };
    ws.onclose = (ev) => {
      this.onClose?.();
      // 4000/4001 are deliberate kicks; don't fight them
      if (this.wantReconnect && ev.code !== 4000 && ev.code !== 4001) {
        setTimeout(() => this.connect(), 2000);
      }
    };
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.wantReconnect = false;
    this.ws?.close();
  }
}
