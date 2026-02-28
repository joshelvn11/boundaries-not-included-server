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
      judgePlayerId: string;
      submissions: Array<{ submissionId: string }>;
    };
    viewer: {
      hand: Array<{ handCardId: string }>;
    };
  };
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
    const submitResponse = await request(app)
      .post(`/rooms/${roomCode}/submit`)
      .set(authHeaders(participant))
      .send({ handCardId: snapshot.viewer.hand[0].handCardId });
    expect(submitResponse.status).toBe(200);
  }

  const judgeAuth = [hostAuth, player2Auth, player3Auth].find(
    (auth) => auth.playerId === judgeId
  ) as Auth;
  const pickSnapshot = await getSnapshot(roomCode, judgeAuth);
  const submissionId = pickSnapshot.game.submissions[0].submissionId;

  const db = requireConnection();
  const winningPlayer = db
    .prepare("SELECT player_id FROM round_submissions WHERE id = ? LIMIT 1")
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

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `bni-rooms-test-${Date.now()}-${Math.random()}.sqlite`);
  await runMigrations(dbPath, path.resolve(process.cwd(), "drizzle"));

  ({ connection } = createDb(dbPath));
  connection
    .prepare(
      `INSERT INTO white_cards (id, text, pack, source_id, is_active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("white_1", "A tiny horse", "base", "white_source_1", 1);
  connection
    .prepare(
      `INSERT INTO white_cards (id, text, pack, source_id, is_active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("white_2", "An awkward hug", "base", "white_source_2", 1);
  connection
    .prepare(
      `INSERT INTO white_cards (id, text, pack, source_id, is_active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("white_3", "An otter in sunglasses", "base", "white_source_3", 1);
  connection
    .prepare(
      `INSERT INTO white_cards (id, text, pack, source_id, is_active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("white_4", "Shame and regret", "base", "white_source_4", 1);
  connection
    .prepare(
      `INSERT INTO black_cards (id, text, pick_count, pack, source_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run("black_1", "____ ruined my summer.", 1, "base", "black_source_1", 1);
  connection
    .prepare(
      `INSERT INTO black_cards (id, text, pick_count, pack, source_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run("black_2", "In 100 years, ____.", 1, "base", "black_source_2", 1);

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
      .send({ handCardId: "hand_does_not_exist" });

    expect(invalidSubmit.status).toBe(422);
    expect(invalidSubmit.body.error).toBe("CARD_NOT_IN_HAND");
  });

  it("advances from judge pick to next round after selecting winner", async () => {
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

    const startSnapshot = await getSnapshot(roomCode, hostAuth);
    const judgeId = startSnapshot.game.judgePlayerId;
    const participants = [hostAuth, player2Auth, player3Auth].filter((player) => player.playerId !== judgeId);

    for (const participant of participants) {
      const snapshot = await getSnapshot(roomCode, participant);
      const submitResponse = await request(app)
        .post(`/rooms/${roomCode}/submit`)
        .set(authHeaders(participant))
        .send({ handCardId: snapshot.viewer.hand[0].handCardId });
      expect(submitResponse.status).toBe(200);
    }

    const judgeAuth = [hostAuth, player2Auth, player3Auth].find(
      (auth) => auth.playerId === judgeId
    ) as Auth;

    const pickSnapshot = await getSnapshot(roomCode, judgeAuth);
    expect(pickSnapshot.game.submissions.length).toBeGreaterThan(0);

    const pickWinner = await request(app)
      .post(`/rooms/${roomCode}/pick-winner`)
      .set(authHeaders(judgeAuth))
      .send({ submissionId: pickSnapshot.game.submissions[0].submissionId });

    expect(pickWinner.status).toBe(200);
    expect(["ROUND_SUBMIT", "GAME_OVER"]).toContain(pickWinner.body.game.status);
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
