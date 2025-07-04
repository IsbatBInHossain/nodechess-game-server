import { prisma } from '../dependencies.js'

export const attemptToCreateMatch = async (
  clients,
  redisClient,
  isGuestGame
) => {
  const LOCK_KEY = 'matchmaking_lock'
  const LOCK_TTL = 5000 // 5 seconds to avoid deadlocks

  // Try to acquire the lock. Set if not exists.
  const lockAcquired = await redisClient.set(LOCK_KEY, 'locked', {
    NX: true,
    PX: LOCK_TTL,
  })

  if (!lockAcquired) {
    console.log('Matchmaker is already running. Skipping this attempt.')
    return
  }
  const matchmaking_queueKey = isGuestGame
    ? 'matchmaking_queue:guest'
    : 'matchmaking_queue'
  try {
    const queueLength = await redisClient.lLen(matchmaking_queueKey)

    if (queueLength >= 2) {
      const playerOneIdStr = await redisClient.rPop(matchmaking_queueKey)
      const playerTwoIdStr = await redisClient.rPop(matchmaking_queueKey)

      if (!playerOneIdStr || !playerTwoIdStr) {
        console.log('Failed to pop two players despite queue length.')
        return
      }

      let playerOneId, playerTwoId
      if (isGuestGame) {
        // For guests, the IDs are already strings (UUIDs)
        playerOneId = playerOneIdStr
        playerTwoId = playerTwoIdStr
      } else {
        // For registered users, the IDs are numbers
        playerOneId = parseInt(playerOneIdStr)
        playerTwoId = parseInt(playerTwoIdStr)
      }

      let whitePlayerId, blackPlayerId
      if (Math.random() > 0.5) {
        whitePlayerId = playerOneId
        blackPlayerId = playerTwoId
      } else {
        whitePlayerId = playerTwoId
        blackPlayerId = playerOneId
      }
      let gameId
      if (isGuestGame) {
        gameId = await redisClient.incr('guest_game_id')
      } else {
        // Update the database to set the players for the game
        const game = await prisma.game.create({
          data: { whitePlayerId, blackPlayerId, status: 'IN_PROGRESS' },
        })
        gameId = game.id
      }

      const initialGameState = {
        board: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        turn: 'w',
        whitePlayerId,
        blackPlayerId,
        gameId,
        whiteTime: 300000,
        blackTime: 300000,
        lastMoveTimestamp: Date.now(),
      }
      await redisClient.set(`game:${gameId}`, JSON.stringify(initialGameState))
      // console.log(initialGameState)

      const whitePlayerSocket = clients.get(whitePlayerId)
      const blackPlayerSocket = clients.get(blackPlayerId)

      if (whitePlayerSocket) {
        whitePlayerSocket.send(
          JSON.stringify({
            type: 'game_start',
            gameId,
            color: 'w',
            whiteTime: initialGameState.whiteTime,
            blackTime: initialGameState.blackTime,
          })
        )
      } else {
        console.warn(`White player socket not found for ID: ${whitePlayerId}`)
      }

      if (blackPlayerSocket) {
        blackPlayerSocket.send(
          JSON.stringify({
            type: 'game_start',
            gameId: gameId,
            color: 'b',
            whiteTime: initialGameState.whiteTime,
            blackTime: initialGameState.blackTime,
          })
        )
      } else {
        console.warn(`Black player socket not found for ID: ${blackPlayerId}`)
      }

      console.log(
        `Match created: Game ${gameId} between ${whitePlayerId} (white) and ${blackPlayerId} (black)`
      )
    } else {
      console.log('Not enough players to create a match.')
    }
  } catch (err) {
    console.error('Matchmaker failed:', err)
  } finally {
    // Release the lock
    await redisClient.del(LOCK_KEY)
  }
}
