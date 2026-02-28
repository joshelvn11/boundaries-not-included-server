export const ROOM_STATUS = {
  OPEN: "ROOM_OPEN",
  IN_GAME: "IN_GAME",
  CLOSED: "CLOSED"
} as const;

export const GAME_STATUS = {
  SUBMIT: "ROUND_SUBMIT",
  PICK_WINNER: "ROUND_PICK_WINNER",
  ROUND_RESULTS: "ROUND_RESULTS",
  OVER: "GAME_OVER"
} as const;

export type RoomStatus = (typeof ROOM_STATUS)[keyof typeof ROOM_STATUS];
export type GameStatus = (typeof GAME_STATUS)[keyof typeof GAME_STATUS];

export const DEFAULT_SETTINGS = {
  maxPlayers: 10,
  targetScore: 7
} as const;

export const LIMITS = {
  roomCodeLength: 6,
  minPlayersToStart: 3,
  handSize: 10,
  reconnectGraceMs: 90_000,
  minDisplayNameLength: 2,
  maxDisplayNameLength: 24,
  minTargetScore: 3,
  maxTargetScore: 20,
  minMaxPlayers: 3,
  maxMaxPlayers: 10
} as const;

export type RoomSettings = {
  maxPlayers: number;
  targetScore: number;
};

export type RoomSnapshot = {
  room: {
    id: string;
    code: string;
    status: RoomStatus;
    settings: RoomSettings;
  };
  members: Array<{
    playerId: string;
    displayName: string;
    isHost: boolean;
    isReady: boolean;
    score: number;
    connected: boolean;
    handCount: number;
  }>;
  game: null | {
    id: string;
    status: GameStatus;
    currentRound: number;
    judgePlayerId: string | null;
    prompt: null | {
      cardId: string;
      text: string;
      pickCount: number;
    };
    submissions: Array<{
      submissionId: string;
      text: string;
      revealOrder: number | null;
      playerId?: string;
      displayName?: string;
      isWinner?: boolean;
    }>;
    submittedCount: number;
    requiredCount: number;
    winnerPlayerId: string | null;
    endedReason: string | null;
  };
  viewer: {
    playerId: string;
    displayName: string;
    isHost: boolean;
    isReady: boolean;
    score: number;
    connected: boolean;
    hand: Array<{
      handCardId: string;
      cardId: string;
      text: string;
      pack: string;
    }>;
  };
};

export type SessionBundle = {
  playerId: string;
  reconnectToken: string;
};

export type RequestAuthContext = {
  roomId: string;
  roomCode: string;
  playerId: string;
};
