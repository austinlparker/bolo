/** Keyboard + mouse -> protocol messages. Bolo-style held controls. */
import type { InputMsg } from '@bolo/shared';
import type { Hud } from './hud';
import { TOOLS } from './hud';
import type { Net } from './net';
import type { Renderer } from './render';

export class Input {
  private held = new Set<string>();
  private last: InputMsg = { t: 'input', accel: 0, turn: 0, fire: false };

  constructor(net: Net, renderer: Renderer, hud: Hud) {
    const send = () => {
      const accel = this.held.has('KeyW') || this.held.has('ArrowUp') ? 1 : this.held.has('KeyS') || this.held.has('ArrowDown') ? -1 : 0;
      const left = this.held.has('KeyA') || this.held.has('ArrowLeft');
      const right = this.held.has('KeyD') || this.held.has('ArrowRight');
      const turn = left && !right ? -1 : right && !left ? 1 : 0;
      const fire = this.held.has('Space');
      const msg: InputMsg = { t: 'input', accel, turn, fire };
      if (msg.accel !== this.last.accel || msg.turn !== this.last.turn || msg.fire !== this.last.fire) {
        this.last = msg;
        net.send(msg);
      }
    };

    addEventListener('keydown', (ev) => {
      if (document.activeElement === hud.chatInput) {
        if (ev.code === 'Enter') {
          const text = hud.chatInput.value.trim();
          if (text) net.send({ t: 'chat', text });
          hud.chatInput.value = '';
          hud.chatInput.style.display = 'none';
          hud.chatInput.blur();
        } else if (ev.code === 'Escape') {
          hud.chatInput.style.display = 'none';
          hud.chatInput.blur();
        }
        return;
      }
      if (ev.code === 'Enter') {
        hud.chatInput.style.display = 'block';
        hud.chatInput.focus();
        ev.preventDefault();
        return;
      }
      const tool = TOOLS.find((t) => ev.key === t.key);
      if (tool) {
        hud.setTool(tool.kind);
        return;
      }
      if (ev.code === 'KeyR') {
        net.send({ t: 'builder_recall' });
        return;
      }
      if (ev.code === 'Space') ev.preventDefault();
      this.held.add(ev.code);
      send();
    });

    addEventListener('keyup', (ev) => {
      this.held.delete(ev.code);
      send();
    });

    addEventListener('blur', () => {
      this.held.clear();
      send();
    });

    // click to dispatch the builder with the selected tool
    renderer.canvas.addEventListener('click', (ev) => {
      const [wx, wy] = renderer.screenToWorld(ev.clientX, ev.clientY);
      net.send({ t: 'builder', order: hud.tool, x: Math.floor(wx), y: Math.floor(wy) });
    });
  }
}
