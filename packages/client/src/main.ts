import './style.css';
import { FACTION_NAMES, type ServerMsg } from '@bolo/shared';
import { Hud } from './hud';
import { Input } from './input';
import { startLeaderboard } from './leaderboard';
import {
  clearCredentials,
  credentialsFromFragment,
  savedCredentials,
  showLogin,
  type Credentials,
} from './login';
import { Net } from './net';
import { Renderer } from './render';
import { startSpectator } from './spectator';
import { loadSprites } from './sprites';
import { GameState } from './state';
import { isTouchDevice, TouchControls } from './touch';

const root = document.getElementById('app')!;

if (location.pathname.startsWith('/map')) {
  void startSpectator(root);
} else if (location.pathname.startsWith('/leaderboard')) {
  startLeaderboard(root);
} else {
  void startPlayer();
}

async function startPlayer(): Promise<void> {
  // kick off the art load immediately; there is no fallback art, so it must
  // resolve before the first frame (login time usually hides it entirely)
  const spritesReady = loadSprites().then(
    () => null,
    (err: unknown) => err ?? new Error('sprite load failed'),
  );

  const fromOauth = credentialsFromFragment();
  let creds: Credentials | null = fromOauth.creds ?? savedCredentials();
  if (!creds) creds = await showLogin(root, fromOauth.error);

  const boot = document.createElement('div');
  boot.className = 'overlay';
  boot.innerHTML = '<div class="boot-msg">loading the war…</div>';
  root.appendChild(boot);
  const loadErr = await spritesReady;
  if (loadErr) {
    console.error('sprites failed to load', loadErr);
    boot.innerHTML =
      '<div class="boot-msg">the war failed to load<br/><br/><button class="kbtn" id="boot-retry">RETRY</button></div>';
    document.getElementById('boot-retry')!.addEventListener('click', () => location.reload());
    return;
  }
  boot.remove();

  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  root.appendChild(canvas);

  const state = new GameState();
  const renderer = new Renderer(canvas);
  const hud = new Hud(root);
  const touch = isTouchDevice();
  if (touch) document.body.classList.add('touch-mode');

  const net = new Net(handleMsg, () => ({
    t: 'hello',
    token: creds!.token,
    role: 'player',
    client: touch ? 'touch' : 'keyboard',
  }));
  hud.onRecall = () => net.send({ t: 'builder_recall' });
  hud.onEmote = (kind) => net.send({ t: 'emote', kind });
  const touchControls = touch ? new TouchControls(root, net) : null;

  function handleMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        state.applyWelcome(msg);
        if (msg.you) {
          const controls = touch
            ? 'left stick drives · right stick turns the tank & fires · ⚒ builds'
            : 'WASD drive · space fire · 1-6 builder tools · click to send builder · R recall · enter chat';
          hud.showBanner(
            `<span class="f-${msg.you.faction}">you fight for ${FACTION_NAMES[msg.you.faction]}</span><br/>` +
              `<small>${controls}</small>`,
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
      case 'emoted':
        state.emotes.set(msg.tankId, { kind: msg.kind, at: performance.now() });
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
        if (msg.code === 'invalid_order') {
          state.pushFeed(`builder: ${msg.msg}`);
          if (touch) hud.showToast(`builder: ${msg.msg}`);
        }
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
    touchControls?.tick(state, now);
    hud.update(state);
  }
  requestAnimationFrame(loop);
}
