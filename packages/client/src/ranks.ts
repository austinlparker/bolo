/** Rank ladder: Kenney Ranks insignia tiered by rating (kills + 3×caps). */

export interface RankTier {
  min: number;
  name: string;
  img: string; // /assets/ranks/<img>.png
}

export const RANKS: RankTier[] = [
  { min: 0, name: 'recruit', img: 'rank009' },
  { min: 10, name: 'private', img: 'rank013' },
  { min: 25, name: 'corporal', img: 'rank014' },
  { min: 50, name: 'sergeant', img: 'rank015' },
  { min: 100, name: 'lieutenant', img: 'rank016' },
  { min: 200, name: 'captain', img: 'rank060' },
  { min: 400, name: 'major', img: 'rank056' },
  { min: 800, name: 'colonel', img: 'rank073' },
  { min: 1500, name: 'general', img: 'rank077' },
];

export function ratingOf(stats: { kills: number; caps: number }): number {
  return stats.kills + stats.caps * 3;
}

export function rankFor(score: number): RankTier {
  let r = RANKS[0];
  for (const tier of RANKS) if (score >= tier.min) r = tier;
  return r;
}

/** The tier after this score's, or null at the top of the ladder. */
export function nextRank(score: number): RankTier | null {
  for (const tier of RANKS) if (score < tier.min) return tier;
  return null;
}

export function rankImgUrl(tier: RankTier): string {
  return `/assets/ranks/${tier.img}.png`;
}
