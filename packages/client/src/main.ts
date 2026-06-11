import './style.css';
import { FACTION_NAMES, type ServerMsg } from '@bolo/shared';
import { Hud } from './hud';
import { Input } from './input';
import { clearCredentials, savedCredentials, showLogin, type Credentials } from './login';
import { Net } from './net';
import { Renderer } from './render';
import { startSpectator } from './spectator';
import { GameState } from './state';

const root = document.getElementById('app')!;

if (location.pathname.startsWith('/map')) {
  startSpectator(root);
} else {
  void startPlayer();
}

async function startPlayer(): Promise<void> {
  let creds: Credentials | null = savedCredentials();
  if (!creds) creds = await showLogin(root);

  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  root.appendChild(canvas);

  const state = new GameState();
  const renderer = new Renderer(canvas);
  const hud = new Hud(root);

  const net = new Net(handleMsg, () => ({ t: 'hello', token: creds!.token, role: 'player' }));

  function handleMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        state.applyWelcome(msg);
        if (msg.you) {
          hud.showBanner(
            `<span class="f-${msg.you.faction}">you fight for ${FACTION_NAMES[msg.you.faction]}</span><br/>` +
              `<small>WASD drive · space fire · 1-6 builder tools · click to send builder · R recall · enter chat</small>`,
            7000,
          );
        }
        break;
      case 'state':
        state.applyState(msg);
        break;
      case 'chat':
        hud.addChat(msg);
        break;
      case 'war_over':
        hud.showBanner(
          `<span class="f-${msg.winner}">${FACTION_NAMES[msg.winner]} HAS TAKEN THE ISLAND</span><br/>` +
            `<small>war ${msg.record.warNumber} lasted ${msg.record.durationMinutes} minutes — new island forming...</small>`,
          15000,
        );
        break;
      case 'new_war':
        hud.showBanner('A NEW WAR BEGINS', 5000);
        break;
      case 'error':
        if (msg.code === 'auth_failed') {
          clearCredentials();
          location.reload();
          return;
        }
        if (msg.code === 'invalid_order') state.pushFeed(`builder: ${msg.msg}`);
        break;
      case 'pong':
      case 'spectate':
        break;
    }
  }

  net.onClose = () => state.pushFeed('connection lost — reconnecting...');
  net.connect();
  new Input(net, renderer, hud);

  function loop(now: number): void {
    requestAnimationFrame(loop);
    renderer.frame(state, now);
    hud.update(state);
  }
  requestAnimationFrame(loop);
}
