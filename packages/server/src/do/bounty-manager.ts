/**
 * Bounty system: social-revenge mechanic for mutual kills.
 *
 * When a tank kills another player who is a mutual follow (both following
 * each other on Bluesky), a bounty is automatically placed on the killer.
 * Connected mutuals of the victim become hunters who can claim the bounty
 * by killing the target, and escalate it for a higher reward.
 *
 * Extracted from GameDO to enable direct unit testing.
 */
import {
  BOUNTY_AUTO_REWARD,
  BOUNTY_MAX_ESCALATION,
  BOUNTY_TTL_TICKS,
  type Bounty,
  type PlayerProfile,
} from '@bolo/shared';
import type { Session, SessionStore } from './session-store';

/** Minimal tank shape needed by bounty logic. */
export interface BountyTank {
  id: number;
  did: string;
  kills: number;
}

/** Minimal world view needed by bounty logic. */
export interface BountyWorld {
  tick: number;
  tanks: Map<number, BountyTank>;
}

/** Kill event shape consumed by bounty processing. */
export interface KillEvent {
  e: string;
  killerDid?: string;
  victimDid?: string;
  killer?: string;
  victim?: string;
}

/** Result of a successful bounty claim. */
export interface BountyClaim {
  targetDid: string;
  targetHandle: string;
  claimerDid: string;
  claimerHandle: string;
  reward: number;
}

export class BountyManager {
  /** Active bounties keyed by target DID. */
  bounties = new Map<string, Bounty>();

  constructor(
    private profiles: Map<string, PlayerProfile>,
    private store: SessionStore,
  ) {}

  /** Check if viewerDid is a hunter on a bounty targeting targetDid. */
  isBountyTargetFor(viewerDid: string, targetDid: string): boolean {
    const bounty = this.bounties.get(targetDid);
    return !!bounty && bounty.hunters.includes(viewerDid);
  }

  /**
   * Create a bounty when a mutual kill occurs. The killer becomes the target;
   * all connected mutuals of the victim become hunters. If a bounty on the
   * killer already exists, refresh TTL and add more hunters instead.
   */
  createBounty(killerDid: string, killerHandle: string, victimDid: string, world: BountyWorld): void {
    // don't stack bounties on the same target
    if (this.bounties.has(killerDid)) {
      // refresh TTL and add more hunters
      const existing = this.bounties.get(killerDid)!;
      for (const s of this.store) {
        if (s.did && s.mutuals.has(victimDid) && !existing.hunters.includes(s.did)) {
          existing.hunters.push(s.did);
        }
      }
      return;
    }
    // collect hunters: all connected mutuals of the victim
    const hunters: string[] = [];
    for (const s of this.store) {
      if (s.did && s.mutuals.has(victimDid)) hunters.push(s.did);
    }
    if (hunters.length === 0) return;
    // find the target's tank id
    let targetTankId = 0;
    for (const tank of world.tanks.values()) {
      if (tank.did === killerDid) {
        targetTankId = tank.id;
        break;
      }
    }
    this.bounties.set(killerDid, {
      targetDid: killerDid,
      targetHandle: killerHandle,
      targetTankId,
      hunters,
      baseReward: BOUNTY_AUTO_REWARD,
      bonusReward: 0,
      createdAtTick: world.tick,
      victimDid,
      escalatedBy: [],
    });
  }

  /**
   * Check for bounty claims from kill events and award rewards.
   *
   * The reward is credited to exactly one ledger: the live tank's kills
   * (persisted via WarManager.foldStats on war end). If the claimer has no
   * live tank (disconnected), the profile is credited directly. This prevents
   * double-counting that would occur if both the profile and the tank were
   * credited and then the tank was folded into the profile.
   *
   * Returns claim notifications to broadcast.
   */
  checkBountyClaims(events: KillEvent[], world: BountyWorld): BountyClaim[] {
    const claims: BountyClaim[] = [];
    for (const ev of events) {
      if (ev.e !== 'kill' || !ev.victimDid || !ev.killerDid) continue;
      const bounty = this.bounties.get(ev.victimDid);
      if (!bounty) continue;
      if (!bounty.hunters.includes(ev.killerDid)) continue;
      // bounty claimed!
      const reward = bounty.baseReward + bounty.bonusReward;
      const claimerProfile = this.profiles.get(ev.killerDid);
      const claimerHandle = claimerProfile?.handle ?? ev.killer ?? 'unknown';
      // Award the bonus in exactly one ledger: the live tank's kills, which
      // foldStats will persist to the profile on war end. Only credit the
      // profile directly when the claimer has no live tank (disconnected),
      // to avoid double-counting (profile + tank → folded = counted twice).
      let credited = false;
      for (const s of this.store) {
        if (s.did === ev.killerDid && s.tankId !== undefined) {
          const tank = world.tanks.get(s.tankId);
          if (tank) {
            tank.kills += reward;
            credited = true;
          }
          break;
        }
      }
      if (!credited && claimerProfile) {
        claimerProfile.kills += reward;
      }
      claims.push({
        targetDid: bounty.targetDid,
        targetHandle: bounty.targetHandle,
        claimerDid: ev.killerDid,
        claimerHandle,
        reward,
      });
      this.bounties.delete(ev.victimDid);
    }
    return claims;
  }

  /** Remove expired bounties. */
  expireBounties(tick: number): void {
    for (const [did, bounty] of this.bounties) {
      if (tick - bounty.createdAtTick > BOUNTY_TTL_TICKS) {
        this.bounties.delete(did);
      }
    }
  }

  /** Broadcast the current bounty list to all players. */
  broadcastBounties(): void {
    if (this.bounties.size === 0) {
      this.store.broadcast({ t: 'bounty_active', bounties: [] });
      return;
    }
    const bounties = [];
    for (const bounty of this.bounties.values()) {
      const victimProfile = this.profiles.get(bounty.victimDid);
      bounties.push({
        targetDid: bounty.targetDid,
        targetHandle: bounty.targetHandle,
        reward: bounty.baseReward + bounty.bonusReward,
        victimHandle: victimProfile?.handle ?? 'unknown',
      });
    }
    this.store.broadcast({ t: 'bounty_active', bounties });
  }

  /** Send current bounties to a specific session (on connect). */
  sendBountiesTo(session: Session): void {
    if (this.bounties.size === 0) return;
    const bounties = [];
    for (const bounty of this.bounties.values()) {
      const victimProfile = this.profiles.get(bounty.victimDid);
      bounties.push({
        targetDid: bounty.targetDid,
        targetHandle: bounty.targetHandle,
        reward: bounty.baseReward + bounty.bonusReward,
        victimHandle: victimProfile?.handle ?? 'unknown',
      });
    }
    this.store.send(session, { t: 'bounty_active', bounties });
  }

  /**
   * Process bounty lifecycle: create bounties from mutual kills, check claims,
   * and expire old bounties. Broadcasts claims and updates.
   */
  processBounties(events: KillEvent[], world: BountyWorld): void {
    // expire old bounties
    const sizeBefore = this.bounties.size;
    this.expireBounties(world.tick);

    // create bounties from mutual kills
    for (const ev of events) {
      if (ev.e !== 'kill' || !ev.killerDid || !ev.victimDid) continue;
      // check if the victim has mutuals who are connected (potential hunters)
      let hasHunter = false;
      for (const s of this.store) {
        if (s.did && s.mutuals.has(ev.victimDid)) {
          hasHunter = true;
          break;
        }
      }
      if (hasHunter) {
        this.createBounty(ev.killerDid, ev.killer!, ev.victimDid, world);
      }
    }

    // check for claims
    const claims = this.checkBountyClaims(events, world);
    for (const claim of claims) {
      this.store.broadcast({
        t: 'bounty_claimed',
        ...claim,
      });
      this.store.broadcastChat('system', `💰 BOUNTY CLAIMED: @${claim.claimerHandle} → @${claim.targetHandle} +${claim.reward}`);
    }

    // broadcast bounty list if it changed
    if (claims.length > 0 || this.bounties.size !== sizeBefore) {
      this.broadcastBounties();
    }
  }

  /**
   * Escalate a bounty: adds +1 to the bonus reward. Only hunters may escalate,
   * one escalation per player per bounty, capped at BOUNTY_MAX_ESCALATION.
   * Returns true if the escalation was applied.
   */
  escalate(sessionDid: string, targetDid: string): boolean {
    const bounty = this.bounties.get(targetDid);
    if (!bounty) return false;
    if (!bounty.hunters.includes(sessionDid)) return false;
    if (bounty.escalatedBy.includes(sessionDid)) return false;
    if (bounty.bonusReward >= BOUNTY_MAX_ESCALATION) return false;
    bounty.bonusReward++;
    bounty.escalatedBy.push(sessionDid);
    this.broadcastBounties();
    return true;
  }

  /**
   * Clear all bounties and broadcast an empty list. Called on new war start
   * to prevent stale bounties from surviving across wars (the new world's
   * tick resets to 0, breaking expiry math for old bounties).
   */
  clear(): void {
    this.bounties.clear();
    this.broadcastBounties();
  }
}
