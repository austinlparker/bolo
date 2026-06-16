import { describe, it, expect, beforeEach } from 'vitest';
import {
  BOUNTY_AUTO_REWARD,
  BOUNTY_MAX_ESCALATION,
  BOUNTY_TTL_TICKS,
  type PlayerProfile,
  type Faction,
} from '@bolo/shared';
import { BountyManager, type BountyWorld } from './bounty-manager';
import type { BountyTank } from './bounty-manager';
import { SessionStore, type Session } from './session-store';
import type { ServerMsg } from '@bolo/shared';

// ---------- mock helpers ----------

/** Create a mock Session suitable for bounty tests. */
function mockSession(did: string, opts: { tankId?: number; mutuals?: string[] } = {}): Session {
  return {
    ws: { send() {} } as unknown as WebSocket,
    role: 'player' as const,
    did,
    handle: did.split(':').pop(),
    tankId: opts.tankId,
    mutuals: new Set(opts.mutuals ?? []),
    pendingTerrain: [],
    msgBudget: 0,
    lastEmoteAt: 0,
  };
}

/** Create a minimal profile. */
function mockProfile(did: string, handle: string, faction: Faction = 'dawn'): PlayerProfile {
  return {
    did,
    handle,
    faction,
    isBot: false,
    kills: 0,
    deaths: 0,
    caps: 0,
    warsFought: 0,
    warsWon: 0,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
  };
}

/** Create a minimal tank for bounty tests. */
function mockTank(id: number, did: string, kills = 0): BountyTank {
  return { id, did, kills };
}

/** Build a BountyWorld from an array of tanks and a tick. */
function mockWorld(tanks: BountyTank[], tick = 100): BountyWorld {
  const map = new Map<number, BountyTank>();
  for (const t of tanks) map.set(t.id, t);
  return { tick, tanks: map };
}

/**
 * A thin SessionStore wrapper that captures broadcasts for assertion.
 * Uses the real SessionStore so iterator semantics match production.
 */
function makeStore(sessions: Session[]): { store: SessionStore; sent: ServerMsg[] } {
  const store = new SessionStore();
  for (const s of sessions) store.add(s);
  const sent: ServerMsg[] = [];
  const origBroadcast = store.broadcast.bind(store);
  const origSend = store.send.bind(store);
  // Spy on sendRaw to capture messages without touching mock WebSockets
  const origSendRaw = (store as unknown as { sendRaw: (s: Session, raw: string) => void }).sendRaw.bind(store);
  (store as unknown as { sendRaw: (s: Session, raw: string) => void }).sendRaw = (_s: Session, raw: string) => {
    sent.push(JSON.parse(raw));
  };
  return { store, sent };
}

// ---------- tests ----------

describe('BountyManager: reward crediting (regression #2 — double-counting)', () => {
  // Scenario: hunter (Alice) kills bounty target (Bob).
  // Alice has both a profile and a live tank.
  // The reward must be credited to tank.kills only — NOT also to profile.kills —
  // because foldStats will later add tank.kills to profile.kills. Crediting both
  // would double-count the reward.

  it('credits reward to tank.kills only when hunter has a live tank', () => {
    const aliceDid = 'did:plc:alice';
    const bobDid = 'did:plc:bob';
    const victimDid = 'did:plc:victim';

    const profiles = new Map<string, PlayerProfile>([
      [aliceDid, mockProfile(aliceDid, 'alice')],
      [victimDid, mockProfile(victimDid, 'victim')],
    ]);

    // Alice is connected with tankId 1
    const aliceSession = mockSession(aliceDid, { tankId: 1 });
    // Alice is a mutual of the victim (makes her a hunter)
    aliceSession.mutuals.add(victimDid);

    const { store } = makeStore([aliceSession]);
    const bm = new BountyManager(profiles, store);

    // Bob (the killer) has tankId 2
    const bobTank = mockTank(2, bobDid, 5); // Bob already has 5 kills
    const aliceTank = mockTank(1, aliceDid, 3); // Alice already has 3 kills
    const world = mockWorld([bobTank, aliceTank]);

    // Create a bounty on Bob (Bob killed victim, who is Alice's mutual)
    bm.createBounty(bobDid, 'bob', victimDid, world);
    expect(bm.bounties.has(bobDid)).toBe(true);

    // Now Alice kills Bob — claiming the bounty
    const events = [{ e: 'kill', killerDid: aliceDid, victimDid: bobDid, killer: 'alice', victim: 'bob' }];
    const claims = bm.checkBountyClaims(events, world);

    expect(claims).toHaveLength(1);
    expect(claims[0].reward).toBe(BOUNTY_AUTO_REWARD);

    // KEY ASSERTION: reward credited to tank.kills, NOT to profile.kills
    expect(aliceTank.kills).toBe(3 + BOUNTY_AUTO_REWARD);
    expect(profiles.get(aliceDid)!.kills).toBe(0); // NOT credited to profile

    // Simulate foldStats: tank.kills → profile.kills
    profiles.get(aliceDid)!.kills += aliceTank.kills;
    expect(profiles.get(aliceDid)!.kills).toBe(3 + BOUNTY_AUTO_REWARD); // counted ONCE
  });

  it('credits reward to profile.kills when hunter has no live tank (disconnected)', () => {
    const aliceDid = 'did:plc:alice';
    const bobDid = 'did:plc:bob';
    const victimDid = 'did:plc:victim';

    const profiles = new Map<string, PlayerProfile>([
      [aliceDid, mockProfile(aliceDid, 'alice')],
      [victimDid, mockProfile(victimDid, 'victim')],
    ]);

    // Alice is NOT connected (no session) — simulating disconnect
    const { store } = makeStore([]);
    const bm = new BountyManager(profiles, store);

    const bobTank = mockTank(2, bobDid, 5);
    const world = mockWorld([bobTank]);

    // Manually create a bounty with Alice as hunter
    bm.bounties.set(bobDid, {
      targetDid: bobDid,
      targetHandle: 'bob',
      targetTankId: 2,
      hunters: [aliceDid],
      baseReward: BOUNTY_AUTO_REWARD,
      bonusReward: 0,
      createdAtTick: 100,
      victimDid,
      escalatedBy: [],
    });

    // Alice kills Bob (claiming the bounty) — but Alice has no live tank
    const events = [{ e: 'kill', killerDid: aliceDid, victimDid: bobDid, killer: 'alice', victim: 'bob' }];
    const claims = bm.checkBountyClaims(events, world);

    expect(claims).toHaveLength(1);
    // KEY ASSERTION: reward credited to profile.kills (fallback, since no live tank)
    expect(profiles.get(aliceDid)!.kills).toBe(BOUNTY_AUTO_REWARD);
  });

  it('total reward includes escalations', () => {
    const aliceDid = 'did:plc:alice';
    const bobDid = 'did:plc:bob';
    const victimDid = 'did:plc:victim';

    const profiles = new Map<string, PlayerProfile>([
      [aliceDid, mockProfile(aliceDid, 'alice')],
    ]);

    const aliceSession = mockSession(aliceDid, { tankId: 1 });
    const { store } = makeStore([aliceSession]);
    const bm = new BountyManager(profiles, store);

    const aliceTank = mockTank(1, aliceDid, 0);
    const bobTank = mockTank(2, bobDid, 0);
    const world = mockWorld([aliceTank, bobTank]);

    // Create bounty then escalate twice
    bm.bounties.set(bobDid, {
      targetDid: bobDid,
      targetHandle: 'bob',
      targetTankId: 2,
      hunters: [aliceDid],
      baseReward: BOUNTY_AUTO_REWARD,
      bonusReward: 0,
      createdAtTick: 100,
      victimDid,
      escalatedBy: [],
    });
    bm.escalate(aliceDid, bobDid);
    bm.escalate(aliceDid, bobDid); // second escalation rejected (one per player)

    // Another player escalates
    const carolDid = 'did:plc:carol';
    const carolSession = mockSession(carolDid, { tankId: 3 });
    carolSession.mutuals.add(victimDid);
    store.add(carolSession);
    bm.bounties.get(bobDid)!.hunters.push(carolDid);
    bm.escalate(carolDid, bobDid);

    // Total reward = base(1) + bonus(2)
    expect(bm.bounties.get(bobDid)!.bonusReward).toBe(2);
    const expectedReward = BOUNTY_AUTO_REWARD + 2;

    // Alice claims
    const events = [{ e: 'kill', killerDid: aliceDid, victimDid: bobDid, killer: 'alice', victim: 'bob' }];
    const claims = bm.checkBountyClaims(events, world);
    expect(claims[0].reward).toBe(expectedReward);
    expect(aliceTank.kills).toBe(expectedReward);
  });
});

describe('BountyManager: war reset (regression #3 — stale bounties)', () => {
  it('clear() empties all bounties and broadcasts an empty bounty_active', () => {
    const profiles = new Map<string, PlayerProfile>();
    const { store, sent } = makeStore([mockSession('did:plc:a')]);
    const bm = new BountyManager(profiles, store);

    // Seed some bounties
    bm.bounties.set('did:plc:target1', {
      targetDid: 'did:plc:target1',
      targetHandle: 'target1',
      targetTankId: 1,
      hunters: ['did:plc:h1'],
      baseReward: 1,
      bonusReward: 0,
      createdAtTick: 5000,
      victimDid: 'did:plc:v1',
      escalatedBy: [],
    });
    bm.bounties.set('did:plc:target2', {
      targetDid: 'did:plc:target2',
      targetHandle: 'target2',
      targetTankId: 2,
      hunters: ['did:plc:h2'],
      baseReward: 1,
      bonusReward: 1,
      createdAtTick: 6000,
      victimDid: 'did:plc:v2',
      escalatedBy: ['did:plc:h2'],
    });
    expect(bm.bounties.size).toBe(2);

    bm.clear();

    expect(bm.bounties.size).toBe(0);
    // Should broadcast an empty bounty_active
    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.t).toBe('bounty_active');
    expect((lastMsg as { bounties: unknown[] }).bounties).toEqual([]);
  });

  it('old-war bounties would survive tick-based expiry after war reset (motivation for clear)', () => {
    // This test documents WHY clear() is needed: a new world starts at tick 0.
    // A bounty created at tick 5000 in the old war has createdAtTick=5000.
    // At new-war tick 0: 0 - 5000 = -5000, which is < BOUNTY_TTL_TICKS (3000),
    // so expireBounties would NOT remove it.
    const profiles = new Map<string, PlayerProfile>();
    const { store } = makeStore([]);
    const bm = new BountyManager(profiles, store);

    bm.bounties.set('did:plc:stale', {
      targetDid: 'did:plc:stale',
      targetHandle: 'stale',
      targetTankId: 1,
      hunters: ['did:plc:h'],
      baseReward: 1,
      bonusReward: 0,
      createdAtTick: 5000,
      victimDid: 'did:plc:v',
      escalatedBy: [],
    });

    // Simulate new war: tick resets to 0
    bm.expireBounties(0);
    expect(bm.bounties.size).toBe(1); // BUG: stale bounty survives!

    // clear() fixes it
    bm.clear();
    expect(bm.bounties.size).toBe(0);
  });
});

describe('BountyManager: escalation', () => {
  it('rejects escalation from non-hunters', () => {
    const profiles = new Map<string, PlayerProfile>();
    const { store } = makeStore([]);
    const bm = new BountyManager(profiles, store);

    bm.bounties.set('did:plc:t', {
      targetDid: 'did:plc:t',
      targetHandle: 't',
      targetTankId: 1,
      hunters: ['did:plc:h1'],
      baseReward: 1,
      bonusReward: 0,
      createdAtTick: 0,
      victimDid: 'did:plc:v',
      escalatedBy: [],
    });

    expect(bm.escalate('did:plc:random', 'did:plc:t')).toBe(false);
    expect(bm.bounties.get('did:plc:t')!.bonusReward).toBe(0);
  });

  it('caps escalation at BOUNTY_MAX_ESCALATION', () => {
    const profiles = new Map<string, PlayerProfile>();
    const { store } = makeStore([]);
    const bm = new BountyManager(profiles, store);

    bm.bounties.set('did:plc:t', {
      targetDid: 'did:plc:t',
      targetHandle: 't',
      targetTankId: 1,
      hunters: ['did:plc:h1', 'did:plc:h2', 'did:plc:h3', 'did:plc:h4'],
      baseReward: 1,
      bonusReward: 0,
      createdAtTick: 0,
      victimDid: 'did:plc:v',
      escalatedBy: [],
    });

    // Each hunter escalates once
    for (const h of ['did:plc:h1', 'did:plc:h2', 'did:plc:h3']) {
      expect(bm.escalate(h, 'did:plc:t')).toBe(true);
    }
    expect(bm.bounties.get('did:plc:t')!.bonusReward).toBe(BOUNTY_MAX_ESCALATION);

    // Fourth hunter's escalation should be rejected (cap reached)
    expect(bm.escalate('did:plc:h4', 'did:plc:t')).toBe(false);
    expect(bm.bounties.get('did:plc:t')!.bonusReward).toBe(BOUNTY_MAX_ESCALATION);
  });
});

describe('BountyManager: expiry', () => {
  it('removes bounties older than BOUNTY_TTL_TICKS', () => {
    const profiles = new Map<string, PlayerProfile>();
    const { store } = makeStore([]);
    const bm = new BountyManager(profiles, store);

    bm.bounties.set('did:plc:old', {
      targetDid: 'did:plc:old',
      targetHandle: 'old',
      targetTankId: 1,
      hunters: [],
      baseReward: 1,
      bonusReward: 0,
      createdAtTick: 100,
      victimDid: 'did:plc:v',
      escalatedBy: [],
    });
    bm.bounties.set('did:plc:new', {
      targetDid: 'did:plc:new',
      targetHandle: 'new',
      targetTankId: 2,
      hunters: [],
      baseReward: 1,
      bonusReward: 0,
      createdAtTick: 100,
      victimDid: 'did:plc:v2',
      escalatedBy: [],
    });

    // At tick 100 + BOUNTY_TTL_TICKS + 1: bounties are past TTL (expiry uses >)
    bm.expireBounties(100 + BOUNTY_TTL_TICKS + 1);
    expect(bm.bounties.size).toBe(0);
  });

  it('keeps bounties within TTL', () => {
    const profiles = new Map<string, PlayerProfile>();
    const { store } = makeStore([]);
    const bm = new BountyManager(profiles, store);

    bm.bounties.set('did:plc:fresh', {
      targetDid: 'did:plc:fresh',
      targetHandle: 'fresh',
      targetTankId: 1,
      hunters: [],
      baseReward: 1,
      bonusReward: 0,
      createdAtTick: 100,
      victimDid: 'did:plc:v',
      escalatedBy: [],
    });

    bm.expireBounties(100 + BOUNTY_TTL_TICKS - 1);
    expect(bm.bounties.size).toBe(1);
  });
});
