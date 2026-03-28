import fs from "fs";
import os from "os";
import path from "path";

import type Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app";
import { createDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { RoomLifecycleService } from "../services/room-lifecycle.service";

type Auth = {
  playerId: string;
  reconnectToken: string;
};

let dbPath = "";
let roomService: RoomLifecycleService;
let app: ReturnType<typeof createApp>;
let connection: Database.Database | null = null;

function authHeaders(auth: Auth) {
  return {
    "x-player-id": auth.playerId,
    authorization: `Bearer ${auth.reconnectToken}`
  };
}

async function getSnapshot(roomCode: string, auth: Auth) {
  const response = await request(app).get(`/rooms/${roomCode}`).set(authHeaders(auth));
  expect(response.status).toBe(200);
  return response.body as {
    game: {
      status: string;
      currentRound: number;
      judgePlayerId: string;
      prompt: { pickCount: number } | null;
      endedReason: string | null;
      submissions: Array<{
        submissionId: string;
        text?: string;
        displayName?: string;
        isWinner?: boolean;
      }>;
    };
    viewer: {
      hand: Array<{ handCardId: string }>;
    };
  };
}

function setActiveBlackCards(activeIds: string[]): void {
  const db = requireConnection();
  db.prepare("UPDATE black_cards SET is_active = 0").run();

  for (const id of activeIds) {
    db.prepare("UPDATE black_cards SET is_active = 1 WHERE id = ?").run(id);
  }
}

async function submitCardsForRound(roomCode: string, auth: Auth, pickCount: number) {
  const snapshot = await getSnapshot(roomCode, auth);
  const handCardIds = snapshot.viewer.hand.slice(0, pickCount).map((card) => card.handCardId);

  expect(handCardIds).toHaveLength(pickCount);

  return request(app)
    .post(`/rooms/${roomCode}/submit`)
    .set(authHeaders(auth))
    .send({ handCardIds });
}

function requireConnection(): Database.Database {
  if (!connection) {
    throw new Error("Database connection not initialized");
  }

  return connection;
}

async function createGameOverRoom(): Promise<{
  roomCode: string;
  hostAuth: Auth;
  player2Auth: Auth;
  player3Auth: Auth;
}> {
  const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
  const roomCode = createResponse.body.roomCode as string;

  const hostAuth: Auth = {
    playerId: createResponse.body.playerId,
    reconnectToken: createResponse.body.reconnectToken
  };

  const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
  const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });

  const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
  const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

  await request(app)
    .post(`/rooms/${roomCode}/ready`)
    .set(authHeaders(player2Auth))
    .send({ isReady: true });
  await request(app)
    .post(`/rooms/${roomCode}/ready`)
    .set(authHeaders(player3Auth))
    .send({ isReady: true });

  const start = await request(app)
    .post(`/rooms/${roomCode}/start`)
    .set(authHeaders(hostAuth))
    .send({});
  expect(start.status).toBe(200);

  const startSnapshot = await getSnapshot(roomCode, hostAuth);
  const judgeId = startSnapshot.game.judgePlayerId;
  const participants = [hostAuth, player2Auth, player3Auth].filter((player) => player.playerId !== judgeId);

  for (const participant of participants) {
    const snapshot = await getSnapshot(roomCode, participant);
    const pickCount = snapshot.game.prompt?.pickCount ?? 1;
    const submitResponse = await submitCardsForRound(roomCode, participant, pickCount);
    expect(submitResponse.status).toBe(200);
  }

  const judgeAuth = [hostAuth, player2Auth, player3Auth].find(
    (auth) => auth.playerId === judgeId
  ) as Auth;
  const pickSnapshot = await getSnapshot(roomCode, judgeAuth);
  const submissionId = pickSnapshot.game.submissions[0].submissionId;

  const db = requireConnection();
  const winningPlayer = db
    .prepare("SELECT player_id FROM round_submissions WHERE submission_group_id = ? LIMIT 1")
    .get(submissionId) as { player_id: string } | undefined;
  expect(winningPlayer).toBeDefined();

  const roomRow = db.prepare("SELECT id FROM rooms WHERE code = ? LIMIT 1").get(roomCode) as
    | { id: string }
    | undefined;
  expect(roomRow).toBeDefined();

  db.prepare("UPDATE room_players SET score = 6 WHERE room_id = ? AND player_id = ?").run(
    roomRow!.id,
    winningPlayer!.player_id
  );

  const pickWinner = await request(app)
    .post(`/rooms/${roomCode}/pick-winner`)
    .set(authHeaders(judgeAuth))
    .send({ submissionId });

  expect(pickWinner.status).toBe(200);
  expect(pickWinner.body.game.status).toBe("GAME_OVER");

  return {
    roomCode,
    hostAuth,
    player2Auth,
    player3Auth
  };
}

async function createRoundResultsRoom(): Promise<{
  roomCode: string;
  hostAuth: Auth;
  player2Auth: Auth;
  player3Auth: Auth;
  judgeAuth: Auth;
  nonJudgeAuth: Auth;
}> {
  const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
  const roomCode = createResponse.body.roomCode as string;

  const hostAuth: Auth = {
    playerId: createResponse.body.playerId,
    reconnectToken: createResponse.body.reconnectToken
  };

  const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
  const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });
  const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
  const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

  await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player2Auth)).send({ isReady: true });
  await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player3Auth)).send({ isReady: true });

  const start = await request(app).post(`/rooms/${roomCode}/start`).set(authHeaders(hostAuth)).send({});
  expect(start.status).toBe(200);

  const startSnapshot = await getSnapshot(roomCode, hostAuth);
  const judgeId = startSnapshot.game.judgePlayerId;
  const participants = [hostAuth, player2Auth, player3Auth].filter((player) => player.playerId !== judgeId);

  for (const participant of participants) {
    const snapshot = await getSnapshot(roomCode, participant);
    const pickCount = snapshot.game.prompt?.pickCount ?? 1;
    const submitResponse = await submitCardsForRound(roomCode, participant, pickCount);
    expect(submitResponse.status).toBe(200);
  }

  const judgeAuth = [hostAuth, player2Auth, player3Auth].find(
    (auth) => auth.playerId === judgeId
  ) as Auth;
  const nonJudgeAuth = [hostAuth, player2Auth, player3Auth].find(
    (auth) => auth.playerId !== judgeId
  ) as Auth;

  const pickSnapshot = await getSnapshot(roomCode, judgeAuth);
  const submissionId = pickSnapshot.game.submissions[0].submissionId;

  const pickWinner = await request(app)
    .post(`/rooms/${roomCode}/pick-winner`)
    .set(authHeaders(judgeAuth))
    .send({ submissionId });

  expect(pickWinner.status, JSON.stringify(pickWinner.body)).toBe(200);
  expect(pickWinner.body.game.status).toBe("ROUND_RESULTS");

  return {
    roomCode,
    hostAuth,
    player2Auth,
    player3Auth,
    judgeAuth,
    nonJudgeAuth
  };
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `bni-rooms-test-${Date.now()}-${Math.random()}.sqlite`);
  await runMigrations(dbPath, path.resolve(process.cwd(), "drizzle"));

  ({ connection } = createDb(dbPath));
  const insertWhiteCard = connection.prepare(
    `INSERT INTO white_cards (id, text, pack, source_id, is_active)
     VALUES (?, ?, ?, ?, ?)`
  );

  for (let i = 1; i <= 16; i += 1) {
    insertWhiteCard.run(`white_${i}`, `White card ${i}`, "base", `white_source_${i}`, 1);
  }

  for (let i = 1; i <= 12; i += 1) {
    insertWhiteCard.run(
      `exp_white_${i}`,
      `Expansion white card ${i}`,
      "expansion",
      `exp_white_source_${i}`,
      1
    );
  }

  const insertBlackCard = connection.prepare(
    `INSERT INTO black_cards (id, text, pick_count, pack, source_id, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insertBlackCard.run("black_one_blank", "____ ruined my summer.", 1, "base", "black_source_1", 1);
  insertBlackCard.run(
    "black_two_blank",
    "Other parents worry about ____ but I stress over ____.",
    2,
    "base",
    "black_source_2",
    1
  );
  insertBlackCard.run("black_no_blank", "Life is good today.", 1, "base", "black_source_3", 1);
  insertBlackCard.run(
    "black_four_blank",
    "____ and ____ plus ____ minus ____.",
    4,
    "base",
    "black_source_4",
    1
  );
  insertBlackCard.run(
    "exp_black_one_blank",
    "Only ____ can save us now.",
    1,
    "expansion",
    "exp_black_source_1",
    1
  );

  roomService = new RoomLifecycleService(connection);
  app = createApp(
    {
      PORT: 4000,
      CORS_ORIGIN: "*",
      BNI_SQLITE_PATH: dbPath
    },
    { roomService }
  );
});

afterEach(() => {
  if (connection) {
    connection.close();
    connection = null;
  }

  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
});

describe("rooms API", () => {
  it("lists playable packs with white/black counts", async () => {
    const response = await request(app).get("/packs");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      packs: [
        { name: "base", whiteCount: 16, blackCount: 3 },
        { name: "expansion", whiteCount: 12, blackCount: 1 }
      ]
    });
  });

  it("creates room with selected packs and persists settings in snapshot", async () => {
    const createResponse = await request(app).post("/rooms").send({
      displayName: "Host",
      settings: {
        maxPlayers: 8,
        targetScore: 5,
        packs: ["expansion"]
      }
    });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.snapshot.room.settings).toEqual({
      maxPlayers: 8,
      targetScore: 5,
      packs: ["expansion"]
    });
  });

  it("rejects room creation when unknown packs are provided", async () => {
    const createResponse = await request(app).post("/rooms").send({
      displayName: "Host",
      settings: {
        packs: ["does-not-exist"]
      }
    });

    expect(createResponse.status).toBe(422);
    expect(createResponse.body.error).toBe("VALIDATION_ERROR");
    expect(createResponse.body.message).toContain("Unknown packs");
  });

  it("legacy create without packs resolves to all playable packs", async () => {
    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.snapshot.room.settings.packs).toEqual(["base", "expansion"]);
  });

  it("starts game using only the selected pack pool", async () => {
    const createResponse = await request(app).post("/rooms").send({
      displayName: "Host",
      settings: {
        packs: ["expansion"]
      }
    });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });
    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player2Auth)).send({ isReady: true });
    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player3Auth)).send({ isReady: true });

    const start = await request(app).post(`/rooms/${roomCode}/start`).set(authHeaders(hostAuth)).send({});
    expect(start.status).toBe(200);
    expect(start.body.game.prompt.cardId).toBe("exp_black_one_blank");
    expect((start.body.viewer.hand as Array<{ pack: string }>).every((card) => card.pack === "expansion")).toBe(
      true
    );
  });

  it("fails start when selected pack pool is emptied before game start", async () => {
    const createResponse = await request(app).post("/rooms").send({
      displayName: "Host",
      settings: {
        packs: ["expansion"]
      }
    });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });
    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player2Auth)).send({ isReady: true });
    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player3Auth)).send({ isReady: true });

    const db = requireConnection();
    db.prepare("UPDATE white_cards SET is_active = 0 WHERE pack = ?").run("expansion");
    db.prepare("UPDATE black_cards SET is_active = 0 WHERE pack = ?").run("expansion");

    const start = await request(app).post(`/rooms/${roomCode}/start`).set(authHeaders(hostAuth)).send({});
    expect(start.status).toBe(409);
    expect(start.body.error).toBe("INVALID_STATE");
    expect(start.body.message).toContain("Card pool is empty");
  });

  it("creates room, joins players, readies all, and starts game", async () => {
    const createResponse = await request(app).post("/rooms").send({
      displayName: "Host",
      settings: {
        maxPlayers: 10,
        targetScore: 7
      }
    });

    expect(createResponse.status).toBe(201);
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });

    expect(join2.status).toBe(200);
    expect(join3.status).toBe(200);

    const player2Auth: Auth = {
      playerId: join2.body.playerId,
      reconnectToken: join2.body.reconnectToken
    };
    const player3Auth: Auth = {
      playerId: join3.body.playerId,
      reconnectToken: join3.body.reconnectToken
    };

    const ready2 = await request(app)
      .post(`/rooms/${roomCode}/ready`)
      .set(authHeaders(player2Auth))
      .send({ isReady: true });
    const ready3 = await request(app)
      .post(`/rooms/${roomCode}/ready`)
      .set(authHeaders(player3Auth))
      .send({ isReady: true });

    expect(ready2.status).toBe(200);
    expect(ready3.status).toBe(200);

    const start = await request(app)
      .post(`/rooms/${roomCode}/start`)
      .set(authHeaders(hostAuth))
      .send({});

    expect(start.status).toBe(200);
    expect(start.body.game.status).toBe("ROUND_SUBMIT");
    expect(start.body.members).toHaveLength(3);
  });

  it("blocks mid-game joins", async () => {
    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;

    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });

    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app)
      .post(`/rooms/${roomCode}/ready`)
      .set(authHeaders(player2Auth))
      .send({ isReady: true });
    await request(app)
      .post(`/rooms/${roomCode}/ready`)
      .set(authHeaders(player3Auth))
      .send({ isReady: true });

    const start = await request(app)
      .post(`/rooms/${roomCode}/start`)
      .set(authHeaders(hostAuth))
      .send({});
    expect(start.status).toBe(200);

    const lateJoin = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Late Join" });
    expect(lateJoin.status).toBe(409);
    expect(lateJoin.body.error).toBe("GAME_IN_PROGRESS_JOIN_BLOCKED");
  });

  it("rejects unauthorized room snapshot requests", async () => {
    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;

    const response = await request(app).get(`/rooms/${roomCode}`);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("UNAUTHORIZED");
  });

  it("rejects submit when card is not in hand", async () => {
    setActiveBlackCards(["black_one_blank"]);

    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;

    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });

    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app)
      .post(`/rooms/${roomCode}/ready`)
      .set(authHeaders(player2Auth))
      .send({ isReady: true });
    await request(app)
      .post(`/rooms/${roomCode}/ready`)
      .set(authHeaders(player3Auth))
      .send({ isReady: true });

    await request(app)
      .post(`/rooms/${roomCode}/start`)
      .set(authHeaders(hostAuth))
      .send({});

    const hostSnapshot = await getSnapshot(roomCode, hostAuth);
    const nonJudgeAuth =
      hostSnapshot.game.judgePlayerId === player2Auth.playerId ? player3Auth : player2Auth;

    const invalidSubmit = await request(app)
      .post(`/rooms/${roomCode}/submit`)
      .set(authHeaders(nonJudgeAuth))
      .send({ handCardIds: ["hand_does_not_exist"] });

    expect(invalidSubmit.status).toBe(422);
    expect(invalidSubmit.body.error).toBe("CARD_NOT_IN_HAND");
  });

  it("moves into round results after judge pick, then advances with judge next-round action", async () => {
    const { roomCode, judgeAuth } = await createRoundResultsRoom();

    const resultsSnapshot = await getSnapshot(roomCode, judgeAuth);
    expect(resultsSnapshot.game.status).toBe("ROUND_RESULTS");
    expect(resultsSnapshot.game.submissions.length).toBeGreaterThan(0);

    const nextRound = await request(app)
      .post(`/rooms/${roomCode}/next-round`)
      .set(authHeaders(judgeAuth))
      .send({});

    expect(nextRound.status).toBe(200);
    expect(nextRound.body.game.status).toBe("ROUND_SUBMIT");
    expect(nextRound.body.game.currentRound).toBe(2);
  });

  it("includes submission attribution and winner marker in round results snapshot", async () => {
    const { roomCode, judgeAuth } = await createRoundResultsRoom();
    const resultsSnapshot = await getSnapshot(roomCode, judgeAuth);

    expect(resultsSnapshot.game.status).toBe("ROUND_RESULTS");
    expect(resultsSnapshot.game.submissions.length).toBeGreaterThan(0);
    expect(resultsSnapshot.game.submissions.every((submission) => typeof submission.displayName === "string")).toBe(
      true
    );
    expect(resultsSnapshot.game.submissions.some((submission) => submission.isWinner === true)).toBe(true);
  });

  it("forbids next-round for non-judge players", async () => {
    const { roomCode, nonJudgeAuth } = await createRoundResultsRoom();

    const nextRound = await request(app)
      .post(`/rooms/${roomCode}/next-round`)
      .set(authHeaders(nonJudgeAuth))
      .send({});

    expect(nextRound.status).toBe(403);
    expect(nextRound.body.error).toBe("FORBIDDEN");
  });

  it("rejects next-round outside round-results state", async () => {
    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const nextRound = await request(app)
      .post(`/rooms/${roomCode}/next-round`)
      .set(authHeaders(hostAuth))
      .send({});

    expect(nextRound.status).toBe(409);
    expect(nextRound.body.error).toBe("INVALID_STATE");
  });

  it("ends game with NOT_ENOUGH_PLAYERS when connected players drop below 3 before next-round", async () => {
    const { roomCode, judgeAuth, nonJudgeAuth } = await createRoundResultsRoom();

    const db = requireConnection();
    const roomRow = db.prepare("SELECT id FROM rooms WHERE code = ? LIMIT 1").get(roomCode) as
      | { id: string }
      | undefined;
    expect(roomRow).toBeDefined();

    db.prepare("UPDATE room_players SET connected = 0 WHERE room_id = ? AND player_id = ?").run(
      roomRow!.id,
      nonJudgeAuth.playerId
    );

    const nextRound = await request(app)
      .post(`/rooms/${roomCode}/next-round`)
      .set(authHeaders(judgeAuth))
      .send({});

    expect(nextRound.status).toBe(200);
    expect(nextRound.body.game.status).toBe("GAME_OVER");
    expect(nextRound.body.game.endedReason).toBe("NOT_ENOUGH_PLAYERS");
  });

  it("requires exactly two cards when prompt has two blanks", async () => {
    setActiveBlackCards(["black_two_blank"]);

    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });
    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player2Auth)).send({ isReady: true });
    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player3Auth)).send({ isReady: true });

    const start = await request(app).post(`/rooms/${roomCode}/start`).set(authHeaders(hostAuth)).send({});
    expect(start.status).toBe(200);
    expect(start.body.game.prompt.pickCount).toBe(2);

    const startSnapshot = await getSnapshot(roomCode, hostAuth);
    const nonJudgeAuth =
      startSnapshot.game.judgePlayerId === player2Auth.playerId ? player3Auth : player2Auth;
    const submitSnapshot = await getSnapshot(roomCode, nonJudgeAuth);

    const oneCardSubmit = await request(app)
      .post(`/rooms/${roomCode}/submit`)
      .set(authHeaders(nonJudgeAuth))
      .send({ handCardIds: [submitSnapshot.viewer.hand[0].handCardId] });

    expect(oneCardSubmit.status).toBe(409);
    expect(oneCardSubmit.body.error).toBe("INVALID_STATE");
    expect(oneCardSubmit.body.message).toContain("exactly 2 cards");

    const twoCardSubmit = await request(app)
      .post(`/rooms/${roomCode}/submit`)
      .set(authHeaders(nonJudgeAuth))
      .send({ handCardIds: submitSnapshot.viewer.hand.slice(0, 2).map((card) => card.handCardId) });

    expect(twoCardSubmit.status).toBe(200);
  });

  it("uses pick count 1 when prompt has no blanks", async () => {
    setActiveBlackCards(["black_no_blank"]);

    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });
    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player2Auth)).send({ isReady: true });
    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player3Auth)).send({ isReady: true });

    const start = await request(app).post(`/rooms/${roomCode}/start`).set(authHeaders(hostAuth)).send({});
    expect(start.status).toBe(200);
    expect(start.body.game.prompt.pickCount).toBe(1);
    expect(start.body.game.prompt.text).toBe("Life is good today.");
  });

  it("skips prompts with more than three blanks when playable prompts exist", async () => {
    setActiveBlackCards(["black_four_blank", "black_one_blank"]);

    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });
    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player2Auth)).send({ isReady: true });
    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player3Auth)).send({ isReady: true });

    const start = await request(app).post(`/rooms/${roomCode}/start`).set(authHeaders(hostAuth)).send({});
    expect(start.status).toBe(200);
    expect(start.body.game.prompt.cardId).toBe("black_one_blank");
    expect(start.body.game.prompt.pickCount).toBe(1);
  });

  it("fails start when only prompts with more than three blanks are playable", async () => {
    setActiveBlackCards(["black_four_blank"]);

    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });
    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player2Auth)).send({ isReady: true });
    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player3Auth)).send({ isReady: true });

    const start = await request(app).post(`/rooms/${roomCode}/start`).set(authHeaders(hostAuth)).send({});
    expect(start.status).toBe(409);
    expect(start.body.error).toBe("INVALID_STATE");
    expect(start.body.message).toContain("No playable black cards");
  });

  it("awards one point when picking winner for grouped submission", async () => {
    setActiveBlackCards(["black_two_blank"]);

    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const join2 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 2" });
    const join3 = await request(app).post(`/rooms/${roomCode}/join`).send({ displayName: "Player 3" });
    const player2Auth: Auth = { playerId: join2.body.playerId, reconnectToken: join2.body.reconnectToken };
    const player3Auth: Auth = { playerId: join3.body.playerId, reconnectToken: join3.body.reconnectToken };

    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player2Auth)).send({ isReady: true });
    await request(app).post(`/rooms/${roomCode}/ready`).set(authHeaders(player3Auth)).send({ isReady: true });
    await request(app).post(`/rooms/${roomCode}/start`).set(authHeaders(hostAuth)).send({});

    const startSnapshot = await getSnapshot(roomCode, hostAuth);
    const judgeId = startSnapshot.game.judgePlayerId;
    const participants = [hostAuth, player2Auth, player3Auth].filter((player) => player.playerId !== judgeId);

    for (const participant of participants) {
      const submitResponse = await submitCardsForRound(roomCode, participant, 2);
      expect(submitResponse.status).toBe(200);
    }

    const judgeAuth = [hostAuth, player2Auth, player3Auth].find((auth) => auth.playerId === judgeId) as Auth;
    const pickSnapshot = await getSnapshot(roomCode, judgeAuth);
    const submissionId = pickSnapshot.game.submissions[0].submissionId;

    const pickWinner = await request(app)
      .post(`/rooms/${roomCode}/pick-winner`)
      .set(authHeaders(judgeAuth))
      .send({ submissionId });
    expect(pickWinner.status).toBe(200);

    const db = requireConnection();
    const winnerRow = db
      .prepare("SELECT player_id FROM round_submissions WHERE submission_group_id = ? LIMIT 1")
      .get(submissionId) as { player_id: string } | undefined;
    const roomRow = db.prepare("SELECT id FROM rooms WHERE code = ? LIMIT 1").get(roomCode) as
      | { id: string }
      | undefined;

    if (!winnerRow || !roomRow) {
      throw new Error("Unable to resolve winner score row");
    }

    const scoreRow = db
      .prepare("SELECT score FROM room_players WHERE room_id = ? AND player_id = ? LIMIT 1")
      .get(roomRow.id, winnerRow.player_id) as { score: number } | undefined;

    expect(scoreRow?.score).toBe(1);
  });

  it("allows host to play again from game over and resets lobby state", async () => {
    const { roomCode, hostAuth } = await createGameOverRoom();

    const playAgain = await request(app)
      .post(`/rooms/${roomCode}/play-again`)
      .set(authHeaders(hostAuth))
      .send({});

    expect(playAgain.status).toBe(200);
    expect(playAgain.body.room.status).toBe("ROOM_OPEN");
    expect(playAgain.body.game).toBeNull();
    expect(playAgain.body.members).toHaveLength(3);

    for (const member of playAgain.body.members as Array<{ isReady: boolean; score: number }>) {
      expect(member.isReady).toBe(false);
      expect(member.score).toBe(0);
    }
  });

  it("forbids play-again for non-host players", async () => {
    const { roomCode, player2Auth } = await createGameOverRoom();

    const playAgain = await request(app)
      .post(`/rooms/${roomCode}/play-again`)
      .set(authHeaders(player2Auth))
      .send({});

    expect(playAgain.status).toBe(403);
    expect(playAgain.body.error).toBe("FORBIDDEN");
  });

  it("rejects play-again when there is no completed game", async () => {
    const createResponse = await request(app).post("/rooms").send({ displayName: "Host" });
    const roomCode = createResponse.body.roomCode as string;
    const hostAuth: Auth = {
      playerId: createResponse.body.playerId,
      reconnectToken: createResponse.body.reconnectToken
    };

    const playAgain = await request(app)
      .post(`/rooms/${roomCode}/play-again`)
      .set(authHeaders(hostAuth))
      .send({});

    expect(playAgain.status).toBe(409);
    expect(playAgain.body.error).toBe("INVALID_STATE");
  });
});
