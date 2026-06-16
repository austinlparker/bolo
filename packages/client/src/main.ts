import './style.css';
import { FACTION_NAMES, PROTOCOL_VERSION, type ServerMsg } from '@bolo/shared';
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
import { hasUnseenBulletins, startNotes } from './notes';
import { Renderer } from './render';
import { Sound } from './sound';
import { startSpectator } from './spectator';
import { loadSprites } from './sprites';
import { GameState } from './state';
import { isTouchDevice, TouchControls } from './touch';

// Mobile browsers can pinch- or double-tap-zoom the page even with
// user-scalable=no in the viewport. Once zoomed in, the touch-action:none
// canvas blocks the pinch-out that would undo it — trapping the view. CSS
// touch-action:none on the root stops this on most browsers; iOS Safari also
// emits non-standard gesture* events for pinches that can bypass touch-action,
// so kill those outright. The game uses a fixed camera zoom, so page-zoom is
// never desirable.
const suppressZoom = (e: Event) => e.preventDefault();
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  addEventListener(ev, suppressZoom, { passive: false });
}

const root = document.getElementById('app')!;

if (location.pathname.startsWith('/map')) {
  void startSpectator(root);
} else if (import.meta.env.DEV && location.pathname.startsWith('/rig')) {
  // control-feel rig: four sim variants side by side (dev only)
  void import('./rig').then((m) => m.startRig(root));
} else if (location.pathname.startsWith('/leaderboard')) {
  startLeaderboard(root);
} else if (location.pathname.startsWith('/notes')) {
  startNotes(root);
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
  // Create the canvas behind the boot overlay so there's no flash of blank
  // canvas; the overlay stays up until the first state frame arrives.
  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  root.appendChild(canvas);

  const state = new GameState();
  const renderer = new Renderer(canvas);
  const hud = new Hud(root);
  const sound = new Sound();
  // browsers gate audio behind a user gesture; any input unlocks it
  addEventListener('pointerdown', () => sound.unlock());
  addEventListener('keydown', () => sound.unlock());
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
  hud.onChat = (text) => net.send({ t: 'chat', text });
  hud.onDispatchHere = (order) => {
    const me = state.me();
    if (me?.alive) net.send({ t: 'builder', order, x: Math.floor(me.x), y: Math.floor(me.y) });
  };
  const touchControls = touch ? new TouchControls(root, net) : null;
  let firstFrame = true;

  function handleMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        // stale bundle in a long-lived tab: reload once to pick up the
        // current build, then fall back to nagging (in case of a cache
        // that survives reloads — never loop)
        if (msg.v !== undefined && msg.v > PROTOCOL_VERSION) {
          const key = `bolo_reload_v${msg.v}`;
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, '1');
            location.reload();
            return;
          }
          hud.showToast('⚠ a new version is out — please refresh', 8000, 'error');
        }
        state.applyWelcome(msg);
        if (msg.you) {
          const controls = touch
            ? 'left ▲▼ throttle (holds) + FIRE · STOP halts · right ◀▶ turn'
            : 'W/S throttle (holds) · X stop · A/D turn · space fire · 1-6 tools · ? manual';
          hud.showBanner(
            `<span class="f-${msg.you.faction}">you fight for ${FACTION_NAMES[msg.you.faction]}</span><br/>` +
              `<small>${controls}</small>`,
            7000,
          );
          // nudge once the welcome banner has had its say
          if (hasUnseenBulletins()) {
            setTimeout(() => {
              if (hasUnseenBulletins()) hud.showToast('📜 new war bulletin — patch notes & commendations', 5000);
            }, 7500);
          }
        }
        // During intermission the server sends no state frames; drop the
        // overlay to reveal the intermission countdown HUD.
        if (firstFrame && msg.war.phase === 'intermission') {
          firstFrame = false;
          boot.remove();
        }
        break;
      case 'state': {
        if (firstFrame) { firstFrame = false; boot.remove(); }
        const prevShells = new Set(state.shells.map((s) => s.id));
        state.applyState(msg);
        const ear = state.me();
        if (ear?.alive) {
          for (const s of state.shells) {
            if (!prevShells.has(s.id)) sound.play('fire', { volume: 0.55, at: s, ear });
          }
          for (const e of msg.events ?? []) {
            if (e.e === 'boom') {
              sound.play(e.kind === 'mine' ? 'bigboom' : 'boom', { volume: 0.8, at: e, ear });
            } else if (e.e === 'kill' && e.victim === ear.handle) {
              sound.play('bigboom', { volume: 1 });
            } else if (e.e === 'base_captured' || e.e === 'pill_captured') {
              sound.play('capture', { volume: e.handle === ear.handle ? 0.9 : 0.4 });
            } else if (e.e === 'base_neutralized') {
              sound.play('bigboom', { volume: 0.5 });
            } else if (e.e === 'mutual_killed') {
              sound.play('boom', { volume: 0.6 });
            } else if (e.e === 'mutual_capture') {
              sound.play('capture', { volume: 0.5 });
            }
          }
        }
        break;
      }
      case 'chat':
        hud.addChat(msg, state);
        break;
      case 'social_data':
        state.applySocialData(msg.profiles);
        break;
      case 'mutuals':
        state.applyMutuals(msg.dids);
        break;
      case 'bounty_active':
        state.applyBountyActive(msg.bounties);
        break;
      case 'bounty_claimed':
        hud.showToast(`💰 BOUNTY CLAIMED: @${msg.claimerHandle} → @${msg.targetHandle} +${msg.reward}`, 4000);
        break;
      case 'emoted':
        state.emotes.set(msg.tankId, { kind: msg.kind, at: performance.now() });
        break;
      case 'war_over':
        // Move the client into intermission so the war panel shows the
        // "next war in Ns" countdown immediately — the server sends no state
        // frames during intermission, so without this the HUD would sit on
        // stale 'active' info for the full ~2 minutes until new_war arrives.
        if (state.war) {
          state.war.phase = 'intermission';
          state.war.nextWarAt = msg.nextWarAt;
          state.war.dominance = null;
        }
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
          // errors shout: a red toast on every platform, not just a feed line
          hud.showToast(`⚠ ${msg.msg}`, 2400, 'error');
          sound.play('error', { volume: 0.7 });
        }
        break;
      case 'pong':
      case 'spectate':
        break;
    }
  }

  net.onClose = () => {
    if (firstFrame) {
      boot.innerHTML = '<div class="boot-msg">connection lost — reconnecting…</div>';
    }
    state.pushFeed('connection lost — reconnecting...');
  };
  const input = new Input(net, renderer, hud, state, sound);
  // after (re)connect, force-resend held controls + cruise so the fresh tank
  // obeys what's currently held instead of sitting idle
  net.onOpen = () => {
    input.resync();
    touchControls?.resync();
  };
  net.connect();

  function loop(now: number): void {
    requestAnimationFrame(loop);
    renderer.frame(state, now);
    input.tick(now); // integrate the keyboard throttle (cruise)
    touchControls?.tick(state, now);
    hud.update(state);
  }
  requestAnimationFrame(loop);
}
