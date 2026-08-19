// Deterministic builders for match-v5 / Live Client / Data Dragon fixtures used
// across the unit tests. No network, no randomness.

import type { MatchDto, MatchParticipantDto } from '../src/main/riot/client'

export function participant(
  over: Partial<MatchParticipantDto> & { puuid: string }
): MatchParticipantDto {
  return {
    puuid: over.puuid,
    teamId: over.teamId ?? 100,
    championId: over.championId ?? 1,
    kills: over.kills ?? 5,
    deaths: over.deaths ?? 3,
    assists: over.assists ?? 7,
    win: over.win ?? true,
    teamPosition: over.teamPosition ?? 'MIDDLE',
    individualPosition: over.individualPosition ?? over.teamPosition ?? 'MIDDLE',
    totalMinionsKilled: over.totalMinionsKilled ?? 150,
    neutralMinionsKilled: over.neutralMinionsKilled ?? 0
  }
}

export function match(
  matchId: string,
  participants: MatchParticipantDto[],
  over: Partial<MatchDto['info']> = {}
): MatchDto {
  return {
    metadata: { matchId },
    info: {
      queueId: over.queueId ?? 420,
      gameDuration: over.gameDuration ?? 1800,
      participants
    }
  }
}

/** Minimal Data Dragon champion.json payload for a handful of champions. */
export const DDRAGON_SAMPLE = {
  version: '14.16.1',
  data: {
    Aatrox: { key: '266', id: 'Aatrox', name: 'Aatrox', tags: ['Fighter', 'Tank'] },
    Ahri: { key: '103', id: 'Ahri', name: 'Ahri', tags: ['Mage', 'Assassin'] },
    Ashe: { key: '22', id: 'Ashe', name: 'Ashe', tags: ['Marksman', 'Support'] },
    Thresh: { key: '412', id: 'Thresh', name: 'Thresh', tags: ['Support', 'Fighter'] },
    LeeSin: { key: '64', id: 'LeeSin', name: 'Lee Sin', tags: ['Fighter', 'Assassin'] },
    MissFortune: { key: '21', id: 'MissFortune', name: 'Miss Fortune', tags: ['Marksman'] },
    // Display name != internal key: exactly the case that broke portraits.
    MasterYi: { key: '11', id: 'MasterYi', name: 'Master Yi', tags: ['Assassin', 'Fighter'] },
    MonkeyKing: { key: '62', id: 'MonkeyKing', name: 'Wukong', tags: ['Fighter', 'Tank'] },
    Sett: { key: '875', id: 'Sett', name: 'Sett', tags: ['Fighter', 'Tank'] }
  }
}
